/**
 * 集成（MOCK_LLM=1）：C3 别人在与我的私聊里问我的分身——触发、私有资料不外泄、
 * 忙碌时自动触发并上报、本人答复 / 暂不答复后分身在同一私聊里接着回复；
 * POST /api/work-items/:id/resolve 的出入参与错误码。
 */
import {
	type BrowserFrame,
	ErrorBodySchema,
	type WorkItem,
	WorkItemListResponseSchema,
	WorkItemResponseSchema,
} from "@orgos/protocol";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { historyMessages } from "@/agent/prompt";
import { scheduler } from "@/agent/scheduler";
import { llmRequests, notes } from "@/db/schema";
import { scoped } from "@/db/scope";
import { createWorkItem } from "@/services/work-items";
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

	it("审批待办的处理尚未接通 → 400 NOT_IMPLEMENTED", async () => {
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
		for (const action of ["approve", "deny"] as const) {
			await expectError(
				await resolve(alice.client, approval.id, { action }),
				400,
				"NOT_IMPLEMENTED",
			);
		}
		const open = await openItems(alice.client);
		expect(open.map((w) => w.id)).toContain(approval.id);
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
