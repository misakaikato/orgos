/**
 * 分身对外：C3 别人在同一个私聊里问我的分身（触发、共享与私有、上报与答复），C4 两个分身协商。
 */
import {
	ConversationListResponseSchema,
	type Event,
	NoteListResponseSchema,
} from "@orgos/protocol";
import {
	check,
	equal,
	eventAfter,
	events,
	excludes,
	expectError,
	expectStatus,
	includes,
	type Member,
	messagesBy,
	openItem,
	openItems,
	post,
	quiet,
	replyFrom,
	resolveItem,
	type Scenario,
	setStatus,
	settle,
} from "./kit";

type Of<T extends Event["type"]> = Extract<Event, { type: T }>;
const is =
	<T extends Event["type"]>(type: T) =>
	(e: Event): e is Of<T> =>
		e.type === type;

async function sharedNotes(m: Member) {
	const body = await expectStatus(
		"读资料",
		await m.client.request("GET", "/api/notes"),
		200,
	);
	return NoteListResponseSchema.parse(body).items.filter(
		(n) => n.visibility === "shared",
	);
}

export const c3: Scenario = {
	name: "C3 在同一个私聊里问对方的分身",
	async run(w, step) {
		const { alice, bob } = w;
		const dm = w.ids.pairDm;
		const agentSpoke = (e: Event) =>
			(e.type === "message.posted" || e.type === "agent.action") &&
			e.actorId !== alice.id &&
			e.actorId !== bob.id;
		const ask = async (text: string) => {
			const asked = await post(bob.client, dm, text, { askTwin: true });
			return (await replyFrom(bob.client, dm, alice.twin, asked.id)).payload
				.text;
		};

		await step("alice 在线、bob 没点名：5 秒内没有任何代理开口", async () => {
			await expectStatus(
				"alice 建共享资料",
				await alice.client.request("POST", "/api/notes", {
					title: "Q4 预算口径",
					body: "不含税",
					visibility: "shared",
				}),
				201,
			);
			await setStatus(alice, "available");
			const asked = await post(bob.client, dm, "#note 预算");
			await quiet("代理消息", bob.client, dm, asked.id, agentSpoke, 5_000);
		});
		await step("问分身：只查到共享资料", async () => {
			const text = await ask("#note 预算");
			check("回复", text.startsWith("完成："), "以“完成：”开头", text);
			includes("回复", text, "不含税");
		});
		await step("问分身：本人的私有记忆不外泄", async () => {
			const text = await ask("#note 看牙");
			includes("回复", text, "无结果");
			excludes("回复", text, "请假");
		});
		await step("本人问自己的分身：看得到私有记忆", async () => {
			const asked = await post(alice.client, w.ids.aliceTwinDm, "#note 看牙");
			const reply = await replyFrom(
				alice.client,
				w.ids.aliceTwinDm,
				alice.twin,
				asked.id,
			);
			includes("回复", reply.payload.text, "请假");
		});

		const question = "交付能否提前到 10 月 1 日";
		await step(
			"alice 忙碌时 bob 直接问：分身上报，私聊里落卡片，alice 有 decision 待办",
			async () => {
				await setStatus(alice, "busy");
				const asked = await post(bob.client, dm, `#escalate ${question}`);
				const card = await eventAfter(
					"escalation.created",
					bob.client,
					dm,
					asked.id,
					is("escalation.created"),
				);
				equal("卡片的问题", card.payload.question, question);
				equal("卡片的发出者", card.actorId, alice.twin.id);
				const item = await openItem(
					"alice 的 decision 待办",
					alice,
					(x) => x.id === card.payload.workItemId,
				);
				equal(
					"待办",
					[item.kind, item.requesterId, item.conversationId],
					["decision", bob.id, dm],
				);
				w.ids.decisionItem = item.id;
			},
		);
		await step(
			"alice 答复“可以”并存为资料：分身在私聊回复“本人答复：可以”，共享资料多一条",
			async () => {
				const before = await sharedNotes(alice);
				const last = (await events(bob.client, dm)).at(-1)?.id ?? 0;
				await resolveItem(alice, w.ids.decisionItem, {
					action: "answer",
					text: "可以",
					saveAsNote: true,
				});
				const reply = await replyFrom(bob.client, dm, alice.twin, last);
				equal("分身的回复", reply.payload.text, "本人答复：可以");
				equal(
					"共享资料数",
					(await sharedNotes(alice)).length,
					before.length + 1,
				);
			},
		);
		await step("alice 本人在私聊里发言：不触发任何代理", async () => {
			const said = await post(alice.client, dm, "#note 预算");
			await quiet("代理消息", alice.client, dm, said.id, agentSpoke, 3_000);
			await setStatus(alice, "available");
		});
		await step("bob 的分身整个过程没有开口", async () => {
			const all = await settle(w, bob.client, dm);
			equal("bob 分身的消息", messagesBy(all, bob.twin.id).length, 0);
		});
		await step(
			"单独找别人的分身或助手建私聊 → 400 AGENT_NOT_REACHABLE",
			async () => {
				for (const target of [alice.twin, alice.ops])
					await expectError(
						`bob 找 ${target.handle}`,
						await bob.client.request("POST", "/api/conversations", {
							kind: "dm",
							withPrincipalId: target.id,
						}),
						400,
						"AGENT_NOT_REACHABLE",
					);
			},
		);
	},
};

/** 某人对单元或自己的分身发出 `#negotiate:<对象> <目标>`：等卡片落在 cardIn 私聊、协商结束，返回协商会话与结束事件；onWaiting 在协商进行中执行（如本人答复 need_owner）。 */
export async function negotiate(
	from: { m: Member; dm: string },
	text: string,
	cardIn: { m: Member; dm: string },
	onWaiting?: () => Promise<void>,
): Promise<{ id: string; ended: Of<"negotiation.ended"> }> {
	const before = (await events(cardIn.m.client, cardIn.dm)).at(-1)?.id ?? 0;
	await post(from.m.client, from.dm, text);
	const started = await eventAfter(
		"negotiation.started",
		cardIn.m.client,
		cardIn.dm,
		before,
		is("negotiation.started"),
	);
	const id = started.payload.negotiationConversationId;
	await onWaiting?.();
	const ended = await eventAfter(
		"negotiation.ended",
		cardIn.m.client,
		id,
		0,
		is("negotiation.ended"),
		{ timeoutMs: 20_000 },
	);
	return { id, ended };
}

async function listed(m: Member, conversationId: string): Promise<boolean> {
	const body = await expectStatus(
		"读会话列表",
		await m.client.request("GET", "/api/conversations"),
		200,
	);
	return ConversationListResponseSchema.parse(body).items.some(
		(i) => i.conversation.id === conversationId,
	);
}

const confirmationOf = (m: Member, negotiationId: string) =>
	openItems(m).then((items) =>
		items.filter(
			(x) =>
				x.kind === "confirmation" &&
				(x.payload as { negotiationConversationId?: string })
					.negotiationConversationId === negotiationId,
		),
	);

export const c4: Scenario = {
	name: "C4 两个分身协商",
	async run(w, step) {
		const { alice, bob } = w;
		const own = { m: alice, dm: w.ids.aliceTwinDm };
		const card = { m: alice, dm: w.ids.pairDm };

		await step(
			"谈妥：协商会话不进列表，私聊里有卡片，proposal 为周四 15:00，双方确认后待办 done",
			async () => {
				const { id, ended } = await negotiate(
					own,
					"#negotiate:bob 约周四讨论预算",
					card,
				);
				const [row] = await w.sql<{ kind: string }[]>`
				select kind from conversations where id = ${id}`;
				equal("会话类型", row?.kind, "negotiation");
				equal("alice 列表里有协商会话", await listed(alice, id), false);
				equal("bob 列表里有协商会话", await listed(bob, id), false);
				equal("结果", ended.payload.outcome, "agreed");
				equal("proposal", ended.payload.proposal, { slot: "周四 15:00" });
				for (const m of [alice, bob]) {
					const [item, ...rest] = await confirmationOf(m, id);
					check(
						`${m.name} 的确认待办`,
						!!item && rest.length === 0,
						"1 条",
						rest.length + (item ? 1 : 0),
					);
					if (!item) continue;
					const done = await resolveItem(m, item.id, { action: "confirm" });
					equal(`${m.name} 确认后`, done.status, "done");
				}
				const resolved = (await events(alice.client, id)).filter(
					is("confirmation.resolved"),
				);
				equal("confirmation.resolved 条数", resolved.length, 2);
			},
		);
		await step(
			"目标含 #needowner：bob 收到 decision，答复后协商继续并结束",
			async () => {
				const { ended } = await negotiate(
					own,
					"#negotiate:bob 约周五评审 #needowner",
					card,
					async () => {
						const item = await openItem(
							"bob 的 decision 待办",
							bob,
							(x) => x.kind === "decision",
						);
						await resolveItem(bob, item.id, { action: "answer", text: "可以" });
					},
				);
				equal("结果", ended.payload.outcome, "agreed");
			},
		);
		await step("目标含 #reject：outcome=rejected，没有确认待办", async () => {
			const { id, ended } = await negotiate(
				own,
				"#negotiate:bob 约周六加班 #reject",
				card,
			);
			equal("结果", ended.payload.outcome, "rejected");
			equal("alice 的确认待办", (await confirmationOf(alice, id)).length, 0);
			equal("bob 的确认待办", (await confirmationOf(bob, id)).length, 0);
		});
	},
};
