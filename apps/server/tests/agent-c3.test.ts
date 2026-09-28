/**
 * 集成（MOCK_LLM=1）：C3 别人在与我的私聊里问我的分身——触发、私有资料不外泄、
 * 忙碌时自动触发并上报、本人答复 / 暂不答复后分身在同一私聊里接着回复；
 * POST /api/work-items/:id/resolve 的出入参与错误码。
 */
import {
	type BrowserFrame,
	DECISION_OPTION_MAX_CHARS,
	ErrorBodySchema,
	type WorkItem,
	WorkItemListResponseSchema,
	WorkItemResponseSchema,
} from "@orgos/protocol";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { historyMessages } from "@/agent/prompt";
import { scheduler } from "@/agent/scheduler";
import { llmRequests, notes } from "@/db/schema";
import { scoped } from "@/db/scope";
import { createWorkItem, decisionOptionsOf } from "@/services/work-items";
import {
	actions,
	captureFrames,
	eventsOf,
	messagesBy,
	openDm,
	say,
} from "./agent-helpers";
import { type Client, createTeam, type TeamMember } from "./helpers";

let alice: TeamMember;
let bob: TeamMember;
let dave: TeamMember;
let aliceTwin: string;
let aliceOpsHandle: string;
let bobTwin: string;
let pairDm: string;

const QUESTION = "交付能否提前到 10 月 1 日";

beforeAll(async () => {
	[alice, bob] = (await createTeam(["Alice", "Bob"])) as [
		TeamMember,
		TeamMember,
	];
	[dave] = (await createTeam(["Dave"])) as [TeamMember];
	const twin = alice.me.agents.find((a) => a.role === "front");
	const ops = alice.me.agents.find((a) => a.role === "specialist");
	aliceTwin = twin?.principal.id ?? "";
	aliceOpsHandle = ops?.principal.handle ?? "";
	bobTwin = bob.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
	pairDm = await openDm(bob.client, alice.me.principal.id);

	const shared = await alice.client.request("POST", "/api/notes", {
		title: "Q4 预算口径",
		body: "不含税",
		visibility: "shared",
	});
	expect(shared.status).toBe(201);
	const ownDm = await openDm(alice.client, aliceTwin);
	await say(alice.client, ownDm, "#remember 私事|下周三请假看牙");
});

function tenant() {
	return scoped(alice.me.tenant.id);
}

async function setStatus(m: TeamMember, status: "available" | "busy") {
	const res = await m.client.request("PATCH", "/api/me/status", { status });
	expect(res.status).toBe(200);
}

async function openItems(c: Client): Promise<WorkItem[]> {
	const res = await c.request("GET", "/api/work-items?status=open");
	expect(res.status).toBe(200);
	return WorkItemListResponseSchema.parse(await res.json()).items;
}

function resolve(c: Client, id: string, body: unknown): Promise<Response> {
	return c.request("POST", `/api/work-items/${id}/resolve`, body);
}

async function expectError(res: Response, status: number, code: string) {
	expect(res.status).toBe(status);
	expect(ErrorBodySchema.parse(await res.json()).error.code).toBe(code);
}

async function sharedNotes() {
	return tenant().select(
		notes,
		eq(notes.ownerId, alice.me.principal.id),
		eq(notes.visibility, "shared"),
	);
}

/** alice 忙碌时 bob 直接发 #escalate，返回新建的 decision 待办。 */
async function escalate(question: string): Promise<WorkItem> {
	await setStatus(alice, "busy");
	const before = (await openItems(alice.client)).length;
	await say(bob.client, pairDm, `#escalate ${question}`);
	const items = await openItems(alice.client);
	expect(items).toHaveLength(before + 1);
	const item = items[0];
	if (!item) throw new Error("没有新的待办");
	return item;
}

describe("C3 同一私聊里问对方的分身", () => {
	it("对方 available 且没点名：不触发任何代理", async () => {
		await setStatus(alice, "available");
		await say(bob.client, pairDm, "#note 预算");
		const events = await eventsOf(bob.client, pairDm);
		expect(events.filter((e) => e.actorId !== bob.me.principal.id)).toEqual([]);
	});

	it("askTwin：分身只查共享资料，私有记忆不外泄", async () => {
		await say(bob.client, pairDm, "#note 预算", { askTwin: true });
		let reply = messagesBy(await eventsOf(bob.client, pairDm), aliceTwin).at(
			-1,
		);
		expect(reply?.payload.text).toMatch(/^完成：/);
		expect(reply?.payload.text).toContain("不含税");

		await say(bob.client, pairDm, "#note 看牙", { askTwin: true });
		reply = messagesBy(await eventsOf(bob.client, pairDm), aliceTwin).at(-1);
		expect(reply?.payload.text).toContain("无结果");
		expect(reply?.payload.text).not.toContain("请假");
	});

	it("本人对自己的分身查询能看到私有记忆", async () => {
		const ownDm = await openDm(alice.client, aliceTwin);
		await say(alice.client, ownDm, "#note 看牙");
		const reply = messagesBy(await eventsOf(alice.client, ownDm), aliceTwin).at(
			-1,
		);
		expect(reply?.payload.text).toContain("请假");
	});

	it("忙碌时自动触发并上报：落卡片、建 decision 待办、推给本人，分身不再回复", async () => {
		const aliceCap = captureFrames(alice.me.principal.id);
		const bobCap = captureFrames(bob.me.principal.id);
		const repliesBefore = messagesBy(
			await eventsOf(bob.client, pairDm),
			aliceTwin,
		).length;
		let item: WorkItem;
		try {
			item = await escalate(QUESTION);
		} finally {
			aliceCap.stop();
			bobCap.stop();
		}
		const events = await eventsOf(bob.client, pairDm);
		const asked = messagesBy(events, bob.me.principal.id).at(-1);
		const created = events.findLast((e) => e.type === "escalation.created");
		expect(created).toMatchObject({
			actorId: aliceTwin,
			onBehalfOfId: alice.me.principal.id,
			payload: { workItemId: item.id, question: QUESTION },
		});
		expect(item).toMatchObject({
			kind: "decision",
			status: "open",
			ownerId: alice.me.principal.id,
			requesterId: bob.me.principal.id,
			conversationId: pairDm,
			sourceEventId: asked?.id,
			payload: { question: QUESTION, askedById: bob.me.principal.id },
		});
		expect(item.title).toContain("Bob问：");
		expect(actions(events).at(-1)?.payload).toMatchObject({
			tool: "escalate_to_owner",
			ok: true,
		});
		expect(messagesBy(events, aliceTwin)).toHaveLength(repliesBefore);

		const pushed = (frames: BrowserFrame[]) =>
			frames.flatMap((f) => (f.t === "work_item" ? [f.workItem.id] : []));
		expect(pushed(aliceCap.frames)).toEqual([item.id]);
		expect(pushed(bobCap.frames)).toEqual([]);
		expect(
			bobCap.frames.some(
				(f) => f.t === "event" && f.event.type === "escalation.created",
			),
		).toBe(true);
	});

	it("本人答复并存为资料：待办 done、落 escalation.resolved、分身在同一私聊回复“本人答复：可以”", async () => {
		const [item] = await openItems(alice.client);
		if (item?.kind !== "decision") throw new Error("缺少 decision");
		const notesBefore = await sharedNotes();
		const aliceCap = captureFrames(alice.me.principal.id);
		let res: Response;
		try {
			res = await resolve(alice.client, item.id, {
				action: "answer",
				text: "可以",
				saveAsNote: true,
			});
			expect(res.status).toBe(200);
			await scheduler.idle(pairDm);
		} finally {
			aliceCap.stop();
		}
		const { workItem } = WorkItemResponseSchema.parse(await res.json());
		expect(workItem).toMatchObject({ status: "done" });
		expect(workItem.resolution).toMatchObject({
			action: "answer",
			text: "可以",
		});
		expect(
			aliceCap.frames.some(
				(f) => f.t === "work_item" && f.workItem.status === "done",
			),
		).toBe(true);
		expect(await openItems(alice.client)).toEqual([]);

		const events = await eventsOf(bob.client, pairDm);
		const resolvedAt = events.findIndex(
			(e) => e.type === "escalation.resolved",
		);
		expect(events[resolvedAt]).toMatchObject({
			actorId: alice.me.principal.id,
			payload: { workItemId: item.id, action: "answer", text: "可以" },
		});
		const reply = events
			.slice(resolvedAt)
			.find((e) => e.type === "message.posted" && e.actorId === aliceTwin);
		expect(reply?.type === "message.posted" && reply.payload.text).toBe(
			"本人答复：可以",
		);

		const notesAfter = await sharedNotes();
		expect(notesAfter).toHaveLength(notesBefore.length + 1);
		const added = notesAfter.find(
			(n) => !notesBefore.some((b) => b.id === n.id),
		);
		expect(added).toMatchObject({
			authorId: alice.me.principal.id,
			title: QUESTION.slice(0, 30),
		});
		expect(workItem.resolution).toMatchObject({ noteId: added?.id });

		const resumed = await tenant().select(
			llmRequests,
			and(
				eq(llmRequests.conversationId, pairDm),
				eq(llmRequests.agentId, aliceTwin),
			),
		);
		expect(resumed.at(-1)?.onBehalfOfId).toBe(bob.me.principal.id);
	});

	it("bob 的分身全程没有发任何消息；本人在私聊里的发言不触发任何代理", async () => {
		const before = await eventsOf(alice.client, pairDm);
		await say(alice.client, pairDm, "#note 预算");
		const after = await eventsOf(alice.client, pairDm);
		expect(after.slice(before.length).map((e) => e.actorId)).toEqual([
			alice.me.principal.id,
		]);
		expect(messagesBy(after, bobTwin)).toEqual([]);
	});

	it("暂不答复：分身告知对方“本人暂不答复”，不写资料", async () => {
		const item = await escalate("能不能打 8 折");
		const notesBefore = await sharedNotes();
		const res = await resolve(alice.client, item.id, { action: "decline" });
		expect(res.status).toBe(200);
		await scheduler.idle(pairDm);
		const { workItem } = WorkItemResponseSchema.parse(await res.json());
		expect(workItem.status).toBe("done");
		expect(workItem.resolution).toEqual({ action: "decline" });
		const events = await eventsOf(bob.client, pairDm);
		expect(
			events.findLast((e) => e.type === "escalation.resolved"),
		).toMatchObject({ payload: { workItemId: item.id, action: "decline" } });
		expect(messagesBy(events, aliceTwin).at(-1)?.payload.text).toBe(
			"本人暂不答复",
		);
		expect(await sharedNotes()).toHaveLength(notesBefore.length);
		await setStatus(alice, "available");
	});
});

describe("escalate_to_owner 的可用范围", () => {
	it("为本人办事时不可用：编造调用返回无权限，不建待办", async () => {
		const ownDm = await openDm(alice.client, aliceTwin);
		const before = (await openItems(alice.client)).length;
		await say(alice.client, ownDm, "#escalate 这个我自己问自己");
		const events = await eventsOf(alice.client, ownDm);
		expect(actions(events).at(-1)?.payload).toMatchObject({
			tool: "escalate_to_owner",
			ok: false,
		});
		expect(messagesBy(events, aliceTwin).at(-1)?.payload.text).toContain(
			"无权限",
		);
		expect(events.some((e) => e.type === "escalation.created")).toBe(false);
		expect(await openItems(alice.client)).toHaveLength(before);
	});

	it("被转交的助手不能上报（只有直接被问到的分身能上报）", async () => {
		const before = (await openItems(alice.client)).length;
		await say(bob.client, pairDm, `#delegate:${aliceOpsHandle} #escalate x`, {
			askTwin: true,
		});
		const reply = messagesBy(await eventsOf(bob.client, pairDm), aliceTwin).at(
			-1,
		);
		expect(reply?.payload.text).toContain("无权限");
		expect(await openItems(alice.client)).toHaveLength(before);
	});
});

describe("决策待办的候选选项", () => {
	const OPTIONS = ["可以，按 85 折签", "不行，最多 9 折", "85 折但要签两年"];

	afterAll(async () => {
		await setStatus(alice, "available");
	});

	it("带候选的上报：待办接口与上报卡片里都有候选", async () => {
		const item = await escalate(`大客户 A 要 85 折|${OPTIONS.join("|")}`);
		expect(item).toMatchObject({
			kind: "decision",
			payload: { question: "大客户 A 要 85 折", options: OPTIONS },
		});
		const created = (await eventsOf(bob.client, pairDm)).findLast(
			(e) => e.type === "escalation.created",
		);
		expect(created).toMatchObject({
			payload: { workItemId: item.id, options: OPTIONS },
		});
	});

	it("选候选答复：事件与结果记下 option，分身转告的正是该候选的文字", async () => {
		const item = (await openItems(alice.client))[0];
		if (item?.kind !== "decision") throw new Error("缺少 decision");
		const res = await resolve(alice.client, item.id, {
			action: "answer",
			text: OPTIONS[1],
			option: 1,
		});
		expect(res.status).toBe(200);
		await scheduler.idle(pairDm);
		const { workItem } = WorkItemResponseSchema.parse(await res.json());
		expect(workItem.resolution).toEqual({
			action: "answer",
			text: OPTIONS[1],
			option: 1,
		});
		const events = await eventsOf(bob.client, pairDm);
		const resolvedAt = events.findLastIndex(
			(e) => e.type === "escalation.resolved",
		);
		expect(events[resolvedAt]).toMatchObject({
			payload: {
				workItemId: item.id,
				action: "answer",
				text: OPTIONS[1],
				option: 1,
			},
		});
		const reply = events
			.slice(resolvedAt)
			.find((e) => e.type === "message.posted" && e.actorId === aliceTwin);
		expect(reply?.type === "message.posted" && reply.payload.text).toBe(
			`本人答复：${OPTIONS[1]}`,
		);
	});

	it("自定义答复（含选了候选又改过）不带 option", async () => {
		const item = await escalate(`能打 8 折吗|${OPTIONS.join("|")}`);
		const res = await resolve(alice.client, item.id, {
			action: "answer",
			text: `${OPTIONS[0]}，下周签`,
		});
		expect(res.status).toBe(200);
		await scheduler.idle(pairDm);
		const { workItem } = WorkItemResponseSchema.parse(await res.json());
		expect(workItem.resolution).toEqual({
			action: "answer",
			text: `${OPTIONS[0]}，下周签`,
		});
		const resolved = (await eventsOf(bob.client, pairDm)).findLast(
			(e) => e.type === "escalation.resolved",
		);
		expect(resolved?.payload).not.toHaveProperty("option");
	});

	it("option 与候选不符（越界、文字不一致、待办没有候选）→ 400，待办仍未处理", async () => {
		const item = await escalate(`能打 7 折吗|${OPTIONS.join("|")}`);
		for (const body of [
			{ action: "answer", text: OPTIONS[0], option: 3 },
			{ action: "answer", text: "随便", option: 0 },
			{ action: "answer", text: OPTIONS[0], option: -1 },
		])
			await expectError(
				await resolve(alice.client, item.id, body),
				400,
				"BAD_REQUEST",
			);
		const plain = await escalate("能不能换个交付方式");
		expect(plain.payload).not.toHaveProperty("options");
		await expectError(
			await resolve(alice.client, plain.id, {
				action: "answer",
				text: "可以",
				option: 0,
			}),
			400,
			"BAD_REQUEST",
		);
		const open = (await openItems(alice.client)).map((w) => w.id);
		expect(open).toEqual(expect.arrayContaining([item.id, plain.id]));
		for (const id of [item.id, plain.id]) {
			expect(
				(await resolve(alice.client, id, { action: "decline" })).status,
			).toBe(200);
			await scheduler.idle(pairDm);
		}
	});

	it("候选超过 4 条时截断，超长、空白、重复的丢弃，不足 2 条时不带候选", async () => {
		const long = "长".repeat(DECISION_OPTION_MAX_CHARS + 1);
		expect(
			decisionOptionsOf([" A ", "B", "A", "", long, "C", "D", "E", "F"]),
		).toEqual(["A", "B", "C", "D"]);
		expect(decisionOptionsOf(["A", long, " "])).toBeUndefined();
		expect(decisionOptionsOf(undefined)).toBeUndefined();

		const item = await escalate(
			"交期选哪天|10 月 8 日|10 月 9 日|10 月 10 日|10 月 11 日|10 月 12 日",
		);
		expect(item.kind === "decision" && item.payload.options).toEqual([
			"10 月 8 日",
			"10 月 9 日",
			"10 月 10 日",
			"10 月 11 日",
		]);
		expect(
			(await resolve(alice.client, item.id, { action: "decline" })).status,
		).toBe(200);
		await scheduler.idle(pairDm);
	});
});

describe("POST /api/work-items/:id/resolve", () => {
	let item: WorkItem;

	beforeAll(async () => {
		item = await escalate("能否加一个导出按钮");
		await setStatus(alice, "available");
	});

	it("入参不合法 → 400：answer 缺 text、未知动作", async () => {
		await expectError(
			await resolve(alice.client, item.id, { action: "answer" }),
			400,
			"BAD_REQUEST",
		);
		await expectError(
			await resolve(alice.client, item.id, { action: "maybe" }),
			400,
			"BAD_REQUEST",
		);
	});

	it("动作与待办类型不符 → 400", async () => {
		await expectError(
			await resolve(alice.client, item.id, { action: "approve" }),
			400,
			"WORK_ITEM_ACTION_MISMATCH",
		);
	});

	it("不是处理人、跨租户、不存在 → 404", async () => {
		await expectError(
			await resolve(bob.client, item.id, { action: "decline" }),
			404,
			"NOT_FOUND",
		);
		await expectError(
			await resolve(dave.client, item.id, { action: "decline" }),
			404,
			"NOT_FOUND",
		);
		await expectError(
			await resolve(alice.client, "not-a-uuid", { action: "decline" }),
			404,
			"NOT_FOUND",
		);
		await expectError(
			await resolve(alice.client, crypto.randomUUID(), { action: "decline" }),
			404,
			"NOT_FOUND",
		);
	});

	it("审批待办用 approve / deny 处理：批准后置 done 并记下结局，再处理 → 409；用 answer → 400", async () => {
		const approval = await createWorkItem(tenant(), {
			kind: "approval",
			payload: {
				runnerId: crypto.randomUUID(),
				capability: "shell.exec",
				args: { command: "echo hi" },
			},
			title: "执行命令",
			body: "echo hi",
			ownerId: alice.me.principal.id,
			requesterId: alice.me.principal.id,
		});
		await expectError(
			await resolve(alice.client, approval.id, { action: "answer", text: "x" }),
			400,
			"WORK_ITEM_ACTION_MISMATCH",
		);
		const ok = await resolve(alice.client, approval.id, { action: "approve" });
		expect(ok.status).toBe(200);
		expect(
			WorkItemResponseSchema.parse(await ok.json()).workItem,
		).toMatchObject({ status: "done", resolution: { outcome: "approve" } });
		await expectError(
			await resolve(alice.client, approval.id, { action: "deny" }),
			409,
			"WORK_ITEM_NOT_OPEN",
		);
	});

	it("已处理的待办再处理 → 409", async () => {
		const first = await resolve(alice.client, item.id, {
			action: "answer",
			text: "可以加",
		});
		expect(first.status).toBe(200);
		await scheduler.idle(pairDm);
		await expectError(
			await resolve(alice.client, item.id, { action: "decline" }),
			409,
			"WORK_ITEM_NOT_OPEN",
		);
	});
});

describe("上报进入代理的上下文", () => {
	it("escalation.created / resolved 以【系统】消息进入历史", () => {
		const base = {
			tenantId: crypto.randomUUID(),
			conversationId: crypto.randomUUID(),
			onBehalfOfId: null,
			createdAt: new Date().toISOString(),
		};
		const workItemId = crypto.randomUUID();
		const names = new Map([
			["twin", "Alice的分身"],
			["alice", "Alice"],
		]);
		const out = historyMessages(
			[
				{
					...base,
					id: 1,
					seq: 1,
					actorId: "twin",
					type: "escalation.created",
					payload: { workItemId, question: "能提前吗" },
				},
				{
					...base,
					id: 2,
					seq: 2,
					actorId: "alice",
					type: "escalation.resolved",
					payload: { workItemId, action: "answer", text: "可以" },
				},
				{
					...base,
					id: 3,
					seq: 3,
					actorId: "alice",
					type: "escalation.resolved",
					payload: { workItemId, action: "decline" },
				},
			],
			"twin",
			(id) => names.get(id) ?? "同事",
		);
		expect(out).toEqual([
			{
				role: "user",
				content: "【系统】Alice的分身已把问题转给本人，等待本人答复：能提前吗",
			},
			{ role: "user", content: "【系统】Alice本人答复了转来的问题：可以" },
			{ role: "user", content: "【系统】Alice本人暂不答复转来的问题" },
		]);
	});
});

describe("群聊里问分身", () => {
	let group: string;
	const post = (body: Record<string, unknown>) =>
		bob.client.request("POST", `/api/conversations/${group}/messages`, body);
	const twinReplies = async () =>
		messagesBy(await eventsOf(bob.client, group), aliceTwin).length;

	beforeAll(async () => {
		await setStatus(alice, "available");
		const res = await bob.client.request("POST", "/api/conversations", {
			kind: "group",
			title: "问分身群",
			memberIds: [alice.me.principal.id],
		});
		expect(res.status).toBe(201);
		group = ((await res.json()) as { conversation: { id: string } })
			.conversation.id;
	});

	it("本人忙碌但没被点名：分身不开口", async () => {
		await setStatus(alice, "busy");
		await say(bob.client, group, "#note 预算");
		expect(await twinReplies()).toBe(0);
	});

	it("@ 了本人且本人忙碌：分身为发言者回答", async () => {
		await say(bob.client, group, "@alice #note 预算", {
			mentions: [alice.me.principal.id],
		});
		const [reply] = messagesBy(await eventsOf(bob.client, group), aliceTwin);
		expect(reply?.payload.text).toContain("不含税");
		expect(reply?.payload.text).not.toContain("请假");
		await setStatus(alice, "available");
	});

	it("@ 了本人且切到问分身：分身回答；只 @ 本人不问分身：不开口", async () => {
		const before = await twinReplies();
		await say(bob.client, group, "@alice #note 预算", {
			mentions: [alice.me.principal.id],
		});
		expect(await twinReplies()).toBe(before);
		await say(bob.client, group, "@alice #note 预算", {
			mentions: [alice.me.principal.id],
			askTwin: true,
		});
		expect(await twinReplies()).toBe(before + 1);
	});

	it("直接 @ 分身：分身为发言者回答", async () => {
		const before = await twinReplies();
		await say(bob.client, group, "#note 预算", { mentions: [aliceTwin] });
		expect(await twinReplies()).toBe(before + 1);
	});

	it("本人在群里 @ 自己的分身：为本人回答（可检索私有记忆）；不 @ 时不触发", async () => {
		const before = await twinReplies();
		await say(alice.client, group, "#note 看牙", {
			mentions: [bob.me.principal.id],
		});
		expect(await twinReplies()).toBe(before);
		await say(alice.client, group, "#note 看牙", { mentions: [aliceTwin] });
		const replies = messagesBy(await eventsOf(bob.client, group), aliceTwin);
		expect(replies).toHaveLength(before + 1);
		expect(replies.at(-1)?.payload.text).toContain("请假");
	});

	it("群里没有 @ 任何人（或只 @ 了代理）时问分身 → 400", async () => {
		for (const body of [
			{ text: "问一下", askTwin: true },
			{ text: "问一下", askTwin: true, mentions: [aliceTwin] },
		]) {
			const res = await post(body);
			expect(res.status).toBe(400);
			expect(ErrorBodySchema.parse(await res.json()).error.code).toBe(
				"BAD_REQUEST",
			);
		}
	});
});
