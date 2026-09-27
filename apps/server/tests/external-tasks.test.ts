/**
 * 集成（MOCK_LLM=1）：外部助手与任务。设备以假连接接入，由测试扮演 Runner 回帧。
 *
 * 接入的校验（只能用自己未吊销的设备、适配器须在上报的可用列表里、工作目录须在设备工作目录内）；
 * 私聊路由（无任务 → 新任务；有未结束任务 → 追问、同一外部会话；一轮进行中的追问排队）；
 * 权限请求 → 审批 → 所选选项原样回传、超时视为拒绝；完成 / 停止 / 新任务；日志 seq 连续；
 * 为他人不可交办、为本人可交办；Runner 重连对账；闲置 24 小时自动完成；吊销设备任务失败。
 */
import {
	AGENT_ACP_CAPABILITY,
	AgentResponseSchema,
	ConversationListResponseSchema,
	CreatePairingCodeResponseSchema,
	deviceCapabilityList,
	type Event,
	PairRunnerResponseSchema,
	type RunnerDown,
	type Task,
	TaskLogResponseSchema,
	TaskResponseSchema,
	type WorkItem,
	WorkItemListResponseSchema,
} from "@orgos/protocol";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scheduler } from "@/agent/scheduler";
import { runners, tasks } from "@/db/schema";
import { scoped } from "@/db/scope";
import {
	externalTasks,
	IDLE_SUMMARY,
	LOST_SUMMARY,
	REVOKED_SUMMARY,
} from "@/services/external-tasks";
import { eventsOf, messagesBy, openDm, say } from "./agent-helpers";
import { anonymous, type Client, createTeam, type TeamMember } from "./helpers";
import { connectRunner, type FakeRunner } from "./runner-helpers";

const WORKSPACE = "/tmp/orgos-ext-ws";

const HELLO = {
	t: "hello",
	protocol: 1,
	runnerVersion: "test",
	os: "macOS arm64",
	hostname: "test-host",
	workspace: WORKSPACE,
	capabilities: [
		...deviceCapabilityList(),
		{
			name: AGENT_ACP_CAPABILITY,
			description: "外部助手",
			risk: "exec",
			adapters: [
				{ id: "fake", command: "bun fake", available: true },
				{ id: "codex", command: "npx codex", available: false },
			],
		},
	],
} as const;

let alice: TeamMember;
let bob: TeamMember;
let twin: string;
let runnerId: string;
let device: FakeRunner;
let ext: { id: string; handle: string };
let dm: string;
const devBefore = process.env.ORGOS_DEV;
const timeoutBefore = externalTasks.options.approvalTimeoutMs;

async function pairRunner(owner: TeamMember, name: string) {
	const codeRes = await owner.client.request(
		"POST",
		"/api/runners/pairing-codes",
	);
	const { code } = CreatePairingCodeResponseSchema.parse(await codeRes.json());
	const paired = await anonymous.request("POST", "/api/runners/pair", {
		code,
		name,
		os: "macOS arm64",
	});
	const id = PairRunnerResponseSchema.parse(await paired.json()).runnerId;
	const row = await scoped(owner.me.tenant.id).first(
		runners,
		eq(runners.id, id),
	);
	if (!row) throw new Error("设备不存在");
	return row;
}

async function until<T>(
	what: string,
	fn: () =>
		| Promise<T | null | undefined | false>
		| T
		| null
		| undefined
		| false,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function task(c: Client, id: string): Promise<Task> {
	const res = await c.request("GET", `/api/tasks/${id}`);
	expect(res.status).toBe(200);
	return TaskResponseSchema.parse(await res.json()).task;
}

function downOf<T extends RunnerDown["t"]>(
	t: T,
	taskId?: string,
): Extract<RunnerDown, { t: T }>[] {
	return device.down.filter(
		(f): f is Extract<RunnerDown, { t: T }> =>
			f.t === t && (!taskId || ("taskId" in f && f.taskId === taskId)),
	);
}

type TaskEvent = Extract<Event, { type: "task.created" }>;

async function lastTaskId(conversationId: string): Promise<string> {
	const created = (await eventsOf(alice.client, conversationId)).filter(
		(e): e is TaskEvent => e.type === "task.created",
	);
	const last = created.at(-1);
	if (!last) throw new Error("没有任务");
	return last.payload.taskId;
}

/** 扮演 Runner：记一段话并结束这一轮。 */
async function finishTurn(taskId: string, text: string, sessionId = "sess-1") {
	await device.up({
		t: "acp_event",
		taskId,
		kind: "agent_text",
		payload: { text },
	});
	await device.up({
		t: "acp_turn_end",
		taskId,
		stopReason: "end_turn",
		sessionId,
	});
}

async function openApprovals(c: Client): Promise<WorkItem[]> {
	const res = await c.request("GET", "/api/work-items?status=open");
	return WorkItemListResponseSchema.parse(await res.json()).items.filter(
		(w) => w.kind === "approval",
	);
}

beforeAll(async () => {
	process.env.ORGOS_DEV = "1";
	[alice, bob] = (await createTeam(["Alice", "Bob"])) as [
		TeamMember,
		TeamMember,
	];
	twin = alice.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
	const row = await pairRunner(alice, "Alice 的 Mac");
	runnerId = row.id;
	device = connectRunner(row);
	await device.up(HELLO);
});

afterAll(async () => {
	process.env.ORGOS_DEV = devBefore;
	externalTasks.options.approvalTimeoutMs = timeoutBefore;
	await device.close();
});

describe("接入外部助手", () => {
	const body = (over: Record<string, unknown> = {}) => ({
		kind: "external",
		displayName: "测试助手",
		handle: `ext${Date.now().toString(36)}`,
		adapter: "fake",
		runnerId,
		workspace: "proj",
		...over,
	});

	it("适配器不在设备上报的可用列表里 → 400", async () => {
		const res = await alice.client.request(
			"POST",
			"/api/agents",
			body({ adapter: "codex" }),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: { code: "ADAPTER_UNAVAILABLE" },
		});
		const unknown = await alice.client.request(
			"POST",
			"/api/agents",
			body({ adapter: "nope" }),
		);
		expect(unknown.status).toBe(400);
	});

	it("只能用自己的设备：别人的设备 → 404；工作目录越出设备工作目录 → 400", async () => {
		const other = await bob.client.request("POST", "/api/agents", body());
		expect(other.status).toBe(404);
		const outside = await alice.client.request(
			"POST",
			"/api/agents",
			body({ workspace: "../etc" }),
		);
		expect(outside.status).toBe(400);
	});

	it("测试适配器只在开发模式下可用", async () => {
		process.env.ORGOS_DEV = "";
		const res = await alice.client.request("POST", "/api/agents", body());
		process.env.ORGOS_DEV = "1";
		expect(res.status).toBe(400);
	});

	it("建好后 engine=acp，出现在代理组与会话列表；不能拉进群", async () => {
		const res = await alice.client.request(
			"POST",
			"/api/agents",
			body({ handle: "alice-ext" }),
		);
		expect(res.status).toBe(201);
		const { agent } = AgentResponseSchema.parse(await res.json());
		expect(agent).toMatchObject({
			engine: "acp",
			adapter: "fake",
			runnerId,
			workspace: `${WORKSPACE}/proj`,
			role: "specialist",
		});
		ext = { id: agent.principal.id, handle: agent.principal.handle };
		const list = ConversationListResponseSchema.parse(
			await (await alice.client.request("GET", "/api/conversations")).json(),
		);
		const found = list.items.find((x) =>
			x.members.some((m) => m.id === ext.id),
		);
		expect(found?.conversation.kind).toBe("dm");
		dm = found?.conversation.id ?? "";
		const group = await alice.client.request("POST", "/api/conversations", {
			kind: "group",
			title: "带外部助手的群",
			memberIds: [ext.id],
		});
		expect(group.status).toBe(400);
		const rebind = await alice.client.request(
			"PATCH",
			`/api/agents/${ext.id}`,
			{ runnerId: null },
		);
		expect(rebind.status).toBe(400);
	});
});

describe("私聊路由与任务状态", () => {
	let first: string;

	it("没有未结束的任务 → 新任务：task.created，下发 acp_start，working → input_required", async () => {
		await say(alice.client, dm, "列出文件");
		first = await lastTaskId(dm);
		const [start] = downOf("acp_start", first);
		expect(start).toMatchObject({
			adapter: "fake",
			workspace: `${WORKSPACE}/proj`,
			prompt: "列出文件",
		});
		expect((await task(alice.client, first)).state).toBe("working");
		await device.up({
			t: "acp_event",
			taskId: first,
			kind: "state",
			payload: { state: "ready", sessionId: "sess-1" },
		});
		await finishTurn(first, "收到：列出文件。我是测试用的假助手。");
		const t = await task(alice.client, first);
		expect(t).toMatchObject({
			state: "input_required",
			engine: "acp",
			externalSessionId: "sess-1",
		});
		expect(t.resultSummary).toContain("我是测试用的假助手");
	});

	it("有未结束的任务 → 追问：同一任务、同一外部会话", async () => {
		await say(alice.client, dm, "再说一次");
		expect(await lastTaskId(dm)).toBe(first);
		expect(downOf("acp_prompt", first).map((f) => f.prompt)).toEqual([
			"再说一次",
		]);
		expect((await task(alice.client, first)).state).toBe("working");
		await finishTurn(first, "第二轮", "sess-1");
		const t = await task(alice.client, first);
		expect(t.state).toBe("input_required");
		expect(t.externalSessionId).toBe("sess-1");
	});

	it("一轮进行中的追问排队，这一轮结束后才发出", async () => {
		await say(alice.client, dm, "第三轮");
		await say(alice.client, dm, "排队的话");
		expect(downOf("acp_prompt", first).map((f) => f.prompt)).toEqual([
			"再说一次",
			"第三轮",
		]);
		await finishTurn(first, "第三轮做完");
		expect(downOf("acp_prompt", first).at(-1)?.prompt).toBe("排队的话");
		expect((await task(alice.client, first)).state).toBe("working");
		await finishTurn(first, "排队的也做完");
		expect((await task(alice.client, first)).state).toBe("input_required");
	});

	it("权限请求 → 审批待办（带工具调用与选项），任务 awaiting_approval；所选选项原样回传", async () => {
		await say(alice.client, dm, "#perm 写入 a.txt");
		await device.up({
			t: "acp_permission",
			taskId: first,
			requestId: "p1",
			toolCall: {
				toolCallId: "perm-1",
				title: "写入 a.txt",
				kind: "edit",
				rawInput: { path: "/tmp/orgos-ext-ws/proj/a.txt", content: "x" },
			},
			options: [
				{ optionId: "allow", name: "允许", kind: "allow_once" },
				{ optionId: "allow_always", name: "始终允许", kind: "allow_always" },
				{ optionId: "reject", name: "拒绝", kind: "reject_once" },
			],
			source: "agent",
		});
		const item = await until("审批待办", async () => {
			const [w] = await openApprovals(alice.client);
			return w;
		});
		expect(item.kind === "approval" && item.payload).toMatchObject({
			taskId: first,
			runnerId,
			capability: AGENT_ACP_CAPABILITY,
			toolCall: { title: "写入 a.txt", kind: "edit" },
			options: [
				{ optionId: "allow" },
				{ optionId: "allow_always" },
				{ optionId: "reject" },
			],
		});
		expect((await task(alice.client, first)).state).toBe("awaiting_approval");
		const mismatch = await alice.client.request(
			"POST",
			`/api/work-items/${item.id}/resolve`,
			{ action: "deny", optionId: "allow" },
		);
		expect(mismatch.status).toBe(400);
		const ok = await alice.client.request(
			"POST",
			`/api/work-items/${item.id}/resolve`,
			{ action: "approve", optionId: "allow_always" },
		);
		expect(ok.status).toBe(200);
		const reply = await until("回传选项", () =>
			downOf("acp_permission_reply", first).find((f) => f.requestId === "p1"),
		);
		expect(reply.optionId).toBe("allow_always");
		await until(
			"回到 working",
			async () => (await task(alice.client, first)).state === "working",
		);
		await device.up({
			t: "acp_event",
			taskId: first,
			kind: "tool_result",
			payload: { title: "写入 a.txt", ok: true, path: "a.txt" },
		});
		await finishTurn(first, "已写入 a.txt");
		const t = await task(alice.client, first);
		expect(t.state).toBe("input_required");
		expect(t.artifacts).toEqual([
			{ kind: "file", label: "a.txt", ref: "a.txt" },
		]);
	});

	it("10 分钟未处理视为拒绝（此处以短超时验证）：代为选拒绝类选项", async () => {
		externalTasks.options.approvalTimeoutMs = 100;
		await say(alice.client, dm, "#perm 写入 late.txt");
		await device.up({
			t: "acp_permission",
			taskId: first,
			requestId: "p2",
			toolCall: { title: "写入 late.txt" },
			options: [
				{ optionId: "allow", name: "允许", kind: "allow_once" },
				{ optionId: "reject", name: "拒绝", kind: "reject_once" },
			],
		});
		const reply = await until("过期后回传", () =>
			downOf("acp_permission_reply", first).find((f) => f.requestId === "p2"),
		);
		externalTasks.options.approvalTimeoutMs = timeoutBefore;
		expect(reply.optionId).toBe("reject");
		const events = await eventsOf(alice.client, dm);
		expect(
			events.find(
				(e) =>
					e.type === "approval.resolved" && e.payload.outcome === "expired",
			),
		).toMatchObject({ payload: { optionId: "reject" } });
		await finishTurn(first, "没写");
	});

	it("日志按 seq 连续", async () => {
		const res = await alice.client.request("GET", `/api/tasks/${first}/log`);
		const { items } = TaskLogResponseSchema.parse(await res.json());
		expect(items.map((l) => l.seq)).toEqual(items.map((_, i) => i + 1));
		expect(items[0]).toMatchObject({
			kind: "prompt",
			payload: { text: "列出文件" },
		});
		expect(items.map((l) => l.kind)).toEqual(
			expect.arrayContaining([
				"agent_text",
				"permission",
				"state",
				"tool_result",
			]),
		);
	});

	it("进度摘要：工具调用之后连续的几段文字合在一起", async () => {
		await say(alice.client, dm, "总结一下");
		await device.up({
			t: "acp_event",
			taskId: first,
			kind: "agent_text",
			payload: { text: "我先看看。" },
		});
		await device.up({
			t: "acp_event",
			taskId: first,
			kind: "tool_call",
			payload: { toolCallId: "t9", title: "Read a.txt" },
		});
		await device.up({
			t: "acp_event",
			taskId: first,
			kind: "agent_text",
			payload: { text: "前半段，" },
		});
		await finishTurn(first, "后半段。");
		expect((await task(alice.client, first)).resultSummary).toBe(
			"前半段，后半段。",
		);
	});

	it("完成：completed、让设备终止进程；再完成 → 409；别人不能看", async () => {
		const res = await alice.client.request(
			"POST",
			`/api/tasks/${first}/complete`,
		);
		expect(res.status).toBe(200);
		expect(TaskResponseSchema.parse(await res.json()).task.state).toBe(
			"completed",
		);
		expect(downOf("acp_cancel", first)).toHaveLength(1);
		const again = await alice.client.request(
			"POST",
			`/api/tasks/${first}/complete`,
		);
		expect(again.status).toBe(409);
		const peek = await bob.client.request("GET", `/api/tasks/${first}`);
		expect(peek.status).toBe(404);
		const ended = (await eventsOf(alice.client, dm)).filter(
			(e) => e.type === "task.ended",
		);
		expect(ended.at(-1)).toMatchObject({
			payload: { taskId: first, state: "completed" },
		});
	});

	it("新任务：强制开新任务（当前未结束的先完成）；停止 → canceled", async () => {
		await say(alice.client, dm, "开个头");
		const second = await lastTaskId(dm);
		expect(second).not.toBe(first);
		const res = await alice.client.request("POST", "/api/tasks", {
			conversationId: dm,
			goal: "另起炉灶",
		});
		expect(res.status).toBe(201);
		const third = TaskResponseSchema.parse(await res.json()).task;
		expect(third.id).not.toBe(second);
		expect((await task(alice.client, second)).state).toBe("completed");
		expect(downOf("acp_start", third.id)[0]?.prompt).toBe("另起炉灶");
		const cancel = await alice.client.request(
			"POST",
			`/api/tasks/${third.id}/cancel`,
		);
		expect(TaskResponseSchema.parse(await cancel.json()).task.state).toBe(
			"canceled",
		);
		const elsewhere = await alice.client.request("POST", "/api/tasks", {
			conversationId: await openDm(alice.client, twin),
			goal: "x",
		});
		expect(elsewhere.status).toBe(400);
	});
});

describe("交办", () => {
	it("为他人：外部助手不在可交办范围内，编造调用 → 无权限", async () => {
		const pair = await openDm(bob.client, alice.me.principal.id);
		const before = downOf("acp_start").length;
		await say(bob.client, pair, `#delegate:${ext.handle} 帮我查个文件`, {
			askTwin: true,
		});
		const [reply] = messagesBy(await eventsOf(bob.client, pair), twin);
		expect(reply?.payload.text).toContain("无权限");
		expect(downOf("acp_start")).toHaveLength(before);
	});

	it("为本人：在本人与它的私聊里开新任务，等这一轮结束，交回摘要", async () => {
		const own = await openDm(alice.client, twin);
		const res = await alice.client.request(
			"POST",
			`/api/conversations/${own}/messages`,
			{ text: `#delegate:${ext.handle} 整理一下文件` },
		);
		expect(res.status).toBe(201);
		const start = await until("下发 acp_start", () =>
			downOf("acp_start").find((f) => f.prompt === "整理一下文件"),
		);
		const t = await task(alice.client, start.taskId);
		expect(t).toMatchObject({ conversationId: dm, requesterId: twin });
		await finishTurn(start.taskId, "整理好了三个文件");
		await scheduler.idle(own);
		const [reply] = messagesBy(await eventsOf(alice.client, own), twin);
		expect(reply?.payload.text).toBe("完成：整理好了三个文件");
		await alice.client.request("POST", `/api/tasks/${start.taskId}/complete`);
	});
});

describe("维护", () => {
	it("Runner 重连：已结束的让它终止，丢失的判失败", async () => {
		await say(alice.client, dm, "丢失的任务");
		const lost = await lastTaskId(dm);
		const endedId = (
			await scoped(alice.me.tenant.id).first(
				tasks,
				eq(tasks.state, "completed"),
			)
		)?.id;
		await device.up({ ...HELLO, acpTasks: [endedId] });
		expect(downOf("acp_cancel", endedId).length).toBeGreaterThan(0);
		const t = await task(alice.client, lost);
		expect(t).toMatchObject({ state: "failed", resultSummary: LOST_SUMMARY });
	});

	it("24 小时没有活动的任务自动完成", async () => {
		await say(alice.client, dm, "放着不管");
		const idle = await lastTaskId(dm);
		await finishTurn(idle, "等你追问");
		const s = scoped(alice.me.tenant.id);
		await s.executor
			.update(tasks)
			.set({ updatedAt: sql`now() - interval '25 hours'` })
			.where(s.where(tasks, eq(tasks.id, idle)));
		expect(await externalTasks.sweepIdle()).toBeGreaterThanOrEqual(1);
		expect(await task(alice.client, idle)).toMatchObject({
			state: "completed",
			resultSummary: IDLE_SUMMARY,
		});
	});

	it("吊销设备：进行中的任务失败，外部助手保留绑定", async () => {
		await say(alice.client, dm, "最后一件事");
		const last = await lastTaskId(dm);
		const res = await alice.client.request(
			"DELETE",
			`/api/runners/${runnerId}`,
		);
		expect(res.status).toBe(204);
		expect(await task(alice.client, last)).toMatchObject({
			state: "failed",
			resultSummary: REVOKED_SUMMARY,
		});
		await say(alice.client, dm, "设备没了还能干活吗");
		const after = await task(alice.client, await lastTaskId(dm));
		expect(after.state).toBe("failed");
	});
});
