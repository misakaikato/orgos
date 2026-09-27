/**
 * 即时通讯与本人的代理组：C2 真人互聊、C1 和自己的代理组聊、群聊轮次、防循环。
 */
import {
	type Event,
	NoteListResponseSchema,
	TaskListResponseSchema,
} from "@orgos/protocol";
import {
	check,
	equal,
	eventAfter,
	events,
	expectStatus,
	includes,
	listen,
	llmRequestCount,
	messagesBy,
	openDm,
	openGroup,
	post,
	replyFrom,
	type Scenario,
	settle,
	waitFor,
} from "./kit";

type ActionEvent = Extract<Event, { type: "agent.action" }>;
const isAction = (e: Event): e is ActionEvent => e.type === "agent.action";

export const c2: Scenario = {
	name: "C2 真人互聊",
	async run(w, step) {
		const { alice, bob } = w;
		await step(
			"alice 与 bob 私聊互发各一条，双方 WS 都收到两条 event",
			async () => {
				const [la, lb] = await Promise.all([listen(alice), listen(bob)]);
				try {
					w.ids.pairDm = await openDm(alice.client, bob.id);
					const a = await post(
						alice.client,
						w.ids.pairDm,
						"明天的评审还开吗？",
					);
					const b = await post(bob.client, w.ids.pairDm, "开，十点，老地方。");
					for (const [who, l] of [
						["alice", la],
						["bob", lb],
					] as const) {
						const seen = await waitFor(
							`${who} 的 WS 收到两条消息`,
							async () => {
								const ids = l.frames.flatMap((f) =>
									f.t === "event" ? [f.event.id] : [],
								);
								return ids.includes(a.id) && ids.includes(b.id) ? ids : null;
							},
						);
						check(`${who} 的 WS 收到两条消息`, seen.length >= 2, "≥2", seen);
					}
				} finally {
					la.close();
					lb.close();
				}
			},
		);
		await step("没有代理成员开口，该会话 llm_requests 为 0 行", async () => {
			await settle(w, alice.client, w.ids.pairDm);
			equal("llm_requests 行数", await llmRequestCount(w, w.ids.pairDm), 0);
		});
	},
};

export const c1: Scenario = {
	name: "C1 和自己的代理组聊",
	async run(w, step) {
		const { alice } = w;
		await step("对分身说“你好”：先有流式 draft，再落“收到：你好”", async () => {
			const l = await listen(alice);
			try {
				w.ids.aliceTwinDm = await openDm(alice.client, alice.twin.id);
				const asked = await post(alice.client, w.ids.aliceTwinDm, "你好");
				const reply = await replyFrom(
					alice.client,
					w.ids.aliceTwinDm,
					alice.twin,
					asked.id,
				);
				equal("分身的回复", reply.payload.text, "收到：你好");
				const drafts = l.frames.filter(
					(f) =>
						f.t === "draft" &&
						f.conversationId === w.ids.aliceTwinDm &&
						f.agentId === alice.twin.id,
				);
				check("draft 帧", drafts.length > 0, "≥1 个 draft 帧", drafts.length);
			} finally {
				l.close();
			}
		});
		await step(
			"#delegate：记下 delegate_to_teammate 动作，回复以“完成：”开头，生成 builtin 任务",
			async () => {
				const asked = await post(
					alice.client,
					w.ids.aliceTwinDm,
					`#delegate:${alice.ops.handle} 整理周报`,
				);
				const reply = await replyFrom(
					alice.client,
					w.ids.aliceTwinDm,
					alice.twin,
					asked.id,
				);
				check(
					"最终回复",
					reply.payload.text.startsWith("完成："),
					"以“完成：”开头",
					reply.payload.text,
				);
				const acts = (await events(alice.client, w.ids.aliceTwinDm)).filter(
					(e): e is ActionEvent => isAction(e) && e.id > asked.id,
				);
				check(
					"delegate_to_teammate 动作",
					acts.some((a) => a.payload.tool === "delegate_to_teammate"),
					"有",
					acts.map((a) => a.payload.tool),
				);
				const tasks = TaskListResponseSchema.parse(
					await expectStatus(
						"读任务",
						await alice.client.request("GET", "/api/tasks"),
						200,
					),
				).items;
				const task = tasks.find((t) => t.goal === "整理周报");
				equal("交办任务", task && { engine: task.engine, state: task.state }, {
					engine: "builtin",
					state: "completed",
				});
			},
		);
		await step(
			"#remember：notes 多一行，作者是分身、visibility=private",
			async () => {
				const notes = async () =>
					NoteListResponseSchema.parse(
						await expectStatus(
							"读资料",
							await alice.client.request("GET", "/api/notes"),
							200,
						),
					).items;
				const before = await notes();
				const asked = await post(
					alice.client,
					w.ids.aliceTwinDm,
					"#remember 私事|下周三请假看牙",
				);
				await replyFrom(alice.client, w.ids.aliceTwinDm, alice.twin, asked.id);
				const added = (await notes()).filter(
					(n) => !before.some((b) => b.id === n.id),
				);
				equal(
					"新增的资料",
					added.map((n) => [n.title, n.authorId, n.visibility]),
					[["私事", alice.twin.id, "private"]],
				);
			},
		);
	},
};

export const groupRounds: Scenario = {
	name: "群聊轮次",
	async run(w, step) {
		const { alice } = w;
		await step("群里只 @ 执行助手：只有它回复，分身不开口", async () => {
			const group = await openGroup(alice.client, "两位代理", [
				alice.twin.id,
				alice.ops.id,
			]);
			const text = `@${alice.ops.handle} 你好`;
			const asked = await post(alice.client, group, text, {
				mentions: [alice.ops.id],
			});
			const reply = await replyFrom(alice.client, group, alice.ops, asked.id);
			equal("执行助手的回复", reply.payload.text, `收到：${text}`);
			const all = await settle(w, alice.client, group);
			equal("分身的消息", messagesBy(all, alice.twin.id).length, 0);
			equal("执行助手的消息", messagesBy(all, alice.ops.id).length, 1);
		});
	},
};

export const antiLoop: Scenario = {
	name: "防循环",
	async run(w, step) {
		const { alice } = w;
		await step(
			"群里同时 @ 两个代理：20 秒内停下，代理消息 ≤8，最后是说明上限的 system 动作",
			async () => {
				const group = await openGroup(alice.client, "互相点名", [
					alice.twin.id,
					alice.ops.id,
				]);
				const started = Date.now();
				await post(
					alice.client,
					group,
					`@${alice.twin.handle} @${alice.ops.handle} 聊聊`,
					{ mentions: [alice.twin.id, alice.ops.id] },
				);
				const last = await eventAfter(
					"system 动作",
					alice.client,
					group,
					0,
					(e): e is ActionEvent => isAction(e) && e.payload.tool === "system",
					{ timeoutMs: 20_000 },
				);
				const all = await settle(w, alice.client, group);
				const elapsed = Date.now() - started;
				check("停下所用时间", elapsed < 20_000, "< 20 秒", `${elapsed} 毫秒`);
				const agentMessages = all.filter(
					(e) => e.type === "message.posted" && e.actorId !== alice.id,
				);
				check(
					"代理消息数",
					agentMessages.length > 0 && agentMessages.length <= 8,
					"1–8 条",
					agentMessages.length,
				);
				equal("最后一个事件", all.at(-1)?.id, last.id);
				equal("system 动作 ok", last.payload.ok, false);
				includes("system 动作说明", last.payload.summary, "上限");
			},
		);
	},
};
