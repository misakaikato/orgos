/**
 * 话题与记忆：同一私聊的两个话题上下文互不泄漏；#fact 自动提炼成记忆、第三人规则、
 * 禁止类别不外露、本人更正优先。
 */
import {
	AnswerActionResponseSchema,
	MemoryItemListResponseSchema,
	RunListResponseSchema,
	TopicResponseSchema,
	TwinAnswerListResponseSchema,
} from "@orgos/protocol";
import {
	check,
	equal,
	events,
	excludes,
	expectStatus,
	includes,
	type Member,
	openDm,
	post,
	replyFrom,
	type Scenario,
	type World,
	waitFor,
} from "./kit";

async function newTopic(m: Member, dm: string, title: string) {
	const body = await expectStatus(
		`开话题“${title}”`,
		await m.client.request("POST", `/api/conversations/${dm}/topics`, {
			title,
		}),
		201,
	);
	return TopicResponseSchema.parse(body).topic.id;
}

/** 某话题最近一次运行的模型输入量（假模型按字数计）。 */
async function lastRunInput(w: World, m: Member, topicId: string) {
	const body = await expectStatus(
		"读运行记录",
		await m.client.request("GET", `/api/runs?topicId=${topicId}`),
		200,
	);
	const [run] = RunListResponseSchema.parse(body).items;
	if (!run) throw new Error("话题里没有运行");
	const [row] = await w.sql<{ n: number }[]>`
		select coalesce(sum(input_tokens), 0)::int as n from llm_requests where run_id = ${run.id}`;
	return row?.n ?? 0;
}

export const topics: Scenario = {
	name: "话题",
	async run(w, step) {
		const { alice } = w;
		const dm = w.ids.aliceTwinDm;
		const secret = `暗号是${"蓝莓".repeat(1000)}`;
		let a = "";
		let b = "";

		await step("同一私聊开两个话题，回复各落在自己的话题里", async () => {
			a = await newTopic(alice, dm, "甲");
			b = await newTopic(alice, dm, "乙");
			const inA = await post(alice.client, dm, secret, { topicId: a });
			await replyFrom(alice.client, dm, alice.twin, inA.id, { topicId: a });
			const inB = await post(alice.client, dm, "乙这边问个事", { topicId: b });
			const reply = await replyFrom(alice.client, dm, alice.twin, inB.id, {
				topicId: b,
			});
			equal("话题乙的回复", reply.payload.text, "收到：乙这边问个事");
			const textsOf = async (topicId: string) =>
				JSON.stringify(await events(alice.client, dm, topicId));
			excludes("话题乙的事件", await textsOf(b), "蓝莓");
			excludes("话题甲的事件", await textsOf(a), "乙这边");
		});
		await step(
			"上下文互不泄漏：乙的运行没有读到甲的长消息，甲的下一轮读到了",
			async () => {
				const bInput = await lastRunInput(w, alice, b);
				check(
					"话题乙的模型输入",
					bInput < 2_000,
					"< 2000 字（不含甲的 2000 字暗号）",
					bInput,
				);
				const again = await post(alice.client, dm, "暗号还记得吗", {
					topicId: a,
				});
				await replyFrom(alice.client, dm, alice.twin, again.id, { topicId: a });
				const aInput = await lastRunInput(w, alice, a);
				check(
					"话题甲的模型输入",
					aInput > 2_000,
					"> 2000 字（含暗号）",
					aInput,
				);
			},
		);
	},
};

/**
 * 快进提炼的 10 分钟去抖：把待执行的 idle 作业改为现在到期，等服务端的提炼执行器取走
 * （每 15 秒一轮），直到 alice 的记忆页里出现期望的条目。
 */
async function extract(w: World, m: Member, contents: string[]) {
	await w.sql`
		update memory_jobs set run_after = now()
		where status = 'pending' and trigger = 'idle'`;
	await waitFor(
		`提炼出 ${contents.join("、")}`,
		async () => {
			const body = await m.client.request("GET", "/api/memory/items");
			const items = MemoryItemListResponseSchema.parse(await body.json()).items;
			return contents.every((c) => items.some((i) => i.content.includes(c)));
		},
		45_000,
	);
}

export const memory: Scenario = {
	name: "记忆",
	async run(w, step) {
		const { alice, bob, carol } = w;
		const ask = async (text: string) => {
			const asked = await post(bob.client, w.ids.pairDm, text, {
				askTwin: true,
			});
			return replyFrom(bob.client, w.ids.pairDm, alice.twin, asked.id);
		};
		let firstAnswer = 0;

		await step(
			"#fact 在 10 分钟无新消息后自动提炼成记忆（不需要说“记住”）",
			async () => {
				const dm = await openDm(alice.client, carol.id);
				await post(
					alice.client,
					dm,
					"#fact 项目进展|和 Carol 确认星火项目完成 80%",
				);
				await post(alice.client, dm, "#fact 薪酬|Alice 月薪三万");
				await extract(w, alice, ["星火项目完成 80%", "月薪三万"]);
			},
		);
		await step(
			"第三人规则：bob 问 alice 的分身，拿到 alice 与 carol 私聊里的事实，但不含 carol 的名字",
			async () => {
				const reply = await ask("#note 星火项目完成");
				const text = reply.payload.text;
				includes("回复", text, "星火项目完成 80%");
				includes("回复的出处", text, "来自与同事的交流");
				excludes("回复", text, "Carol");
				excludes("回复", text, carol.handle);
				excludes("回复", text, "#fact");
				check(
					"回复附依据",
					(reply.payload.citations ?? []).length > 0,
					"≥1 条依据",
					reply.payload.citations,
				);
				firstAnswer = reply.id;
			},
		);
		await step("禁止类别（薪酬）默认不外露", async () => {
			const text = (await ask("#note 月薪")).payload.text;
			includes("回复", text, "无结果");
			excludes("回复", text, "三万");
		});
		await step(
			"本人在代答记录里更正：之后分身按更正回答，依据是本人的更正",
			async () => {
				const list = TwinAnswerListResponseSchema.parse(
					await expectStatus(
						"读代答记录",
						await alice.client.request("GET", "/api/memory/answers"),
						200,
					),
				).items;
				const found = list.find((a) => a.answer.id === firstAnswer);
				equal("代答记录里的提问人", found?.askedById, bob.id);
				const fixed = await expectStatus(
					"更正",
					await alice.client.request(
						"POST",
						`/api/memory/answers/${firstAnswer}/correct`,
						{ text: "星火项目完成 60%，以本人为准" },
					),
					201,
				);
				const [correction] = AnswerActionResponseSchema.parse(fixed).items;
				equal("更正条目", correction?.ownerCorrected, true);
				const again = await ask("#note 星火项目完成");
				includes("更正后的回复", again.payload.text, "60%");
				excludes("更正后的回复", again.payload.text, "80%");
				equal("更正后的依据", again.payload.citations?.[0]?.id, correction?.id);
			},
		);
	},
};
