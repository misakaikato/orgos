/**
 * 集成（MOCK_LLM=1）：外部助手与话题。设备以假连接接入，由测试扮演 Runner 回帧。
 *
 * 接入的校验（只能用自己未吊销的设备、适配器须在上报的可用列表里、工作目录须在设备工作目录内；
 * pi / Hermes 须租户开启且本人勾选确认）；每个话题一个 ACP 会话（两个话题两个外部会话、同话题复用、
 * 一轮进行中的消息排队、这一轮的文字发成消息）；运行记录；权限请求 → 审批落在该话题；
 * 转为任务 / 完成后话题继续可聊 / 新任务；为他人不可交办、为本人在任务话题里交办；
 * Runner 重连对账；闲置 24 小时；吊销设备。
 */
import {
	AGENT_ACP_CAPABILITY,
	AgentResponseSchema,
	ConversationListResponseSchema,
	CreatePairingCodeResponseSchema,
	deviceCapabilityList,
	PairRunnerResponseSchema,
	type Run,
	RunListResponseSchema,
	type RunnerDown,
	RunResponseSchema,
	type Task,
	TaskLogResponseSchema,
	TaskResponseSchema,
	TopicResponseSchema,
	type WorkItem,
	WorkItemListResponseSchema,
} from "@orgos/protocol";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scheduler } from "@/agent/scheduler";
import { runners, tasks } from "@/db/schema";
import { scoped } from "@/db/scope";
import {
	externalSessions,
	LOST_SUMMARY,
	REVOKED_SUMMARY,
	SLOT_IDLE_MS,
} from "@/services/external-sessions";
import {
	eventsOf,
	messagesBy,
	openDm,
	say,
	topicEventsOf,
	topicsOf,
} from "./agent-helpers";
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
				{ id: "pi", command: "npx pi-acp", available: true },
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
let main: string;
const devBefore = process.env.ORGOS_DEV;
const timeoutBefore = externalSessions.options.approvalTimeoutMs;

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

async function runsOf(topicId: string): Promise<Run[]> {
	const res = await alice.client.request("GET", `/api/runs?topicId=${topicId}`);
	expect(res.status).toBe(200);
	return RunListResponseSchema.parse(await res.json()).items.reverse();
}

function downOf<T extends RunnerDown["t"]>(
	t: T,
	slot?: string,
): Extract<RunnerDown, { t: T }>[] {
	return device.down.filter(
		(f): f is Extract<RunnerDown, { t: T }> =>
			f.t === t && (!slot || ("taskId" in f && f.taskId === slot)),
	);
}

/** 扮演 Runner：记一段话并结束这一轮。 */
async function finishTurn(slot: string, text: string, sessionId = "sess-1") {
	await device.up({
		t: "acp_event",
		taskId: slot,
		kind: "agent_text",
		payload: { text },
	});
	await device.up({
		t: "acp_turn_end",
		taskId: slot,
		stopReason: "end_turn",
		sessionId,
	});
}

async function newTopic(conversationId: string, title: string) {
	const res = await alice.client.request(
		"POST",
		`/api/conversations/${conversationId}/topics`,
		{ title },
	);
	expect(res.status).toBe(201);
	return TopicResponseSchema.parse(await res.json()).topic.id;
}

async function sayIn(topicId: string, text: string) {
	const res = await alice.client.request(
		"POST",
		`/api/conversations/${dm}/messages`,
		{ text, topicId },
	);
	expect(res.status).toBe(201);
	await scheduler.idle(dm);
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
	externalSessions.options.approvalTimeoutMs = timeoutBefore;
	await device.close();
});

describe("接入外部助手", () => {
	const body = (over: Record<string, unknown> = {}) => ({
		kind: "external",
		displayName: "测试助手",
		handle: `ext${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
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

	it("pi / Hermes：租户默认不允许；只有 owner 能开启；开启后须本人勾选确认", async () => {
		const off = await alice.client.request(
			"POST",
			"/api/agents",
			body({ adapter: "pi", acknowledgeUnsupervised: true }),
		);
		expect(off.status).toBe(400);
		expect(await off.json()).toMatchObject({
			error: { code: "ADAPTER_UNAVAILABLE" },
		});
		const settings = await alice.client.request("GET", "/api/tenant/settings");
		expect(await settings.json()).toMatchObject({
			settings: { allowUnsupervisedAdapters: false },
		});
		const notOwner = await bob.client.request("PATCH", "/api/tenant/settings", {
			allowUnsupervisedAdapters: true,
		});
		expect(notOwner.status).toBe(403);
		const on = await alice.client.request("PATCH", "/api/tenant/settings", {
			allowUnsupervisedAdapters: true,
		});
		expect(await on.json()).toMatchObject({
			settings: { allowUnsupervisedAdapters: true },
		});
		const unconfirmed = await alice.client.request(
			"POST",
			"/api/agents",
			body({ adapter: "pi" }),
		);
		expect(unconfirmed.status).toBe(400);
		const ok = await alice.client.request(
			"POST",
			"/api/agents",
			body({ adapter: "pi", acknowledgeUnsupervised: true }),
		);
		expect(ok.status).toBe(201);
		const { agent } = AgentResponseSchema.parse(await ok.json());
		expect(agent.adapter).toBe("pi");
		await alice.client.request("DELETE", `/api/agents/${agent.principal.id}`);
		await alice.client.request("PATCH", "/api/tenant/settings", {
			allowUnsupervisedAdapters: false,
		});
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
		main = (await topicsOf(alice.client, dm))[0]?.id ?? "";
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

describe("每个话题一个 ACP 会话", () => {
	let topicB: string;

	it("主线：起会话（acp_start 以话题为会话槽），这一轮的文字发成外部助手的消息；每一段话一次运行", async () => {
		await say(alice.client, dm, "列出文件");
		const [start] = downOf("acp_start", main);
		expect(start).toMatchObject({
			adapter: "fake",
			workspace: `${WORKSPACE}/proj`,
			prompt: "列出文件",
		});
		expect((await runsOf(main)).map((r) => r.state)).toEqual(["running"]);
		await device.up({
			t: "acp_event",
			taskId: main,
			kind: "state",
			payload: { state: "ready", sessionId: "sess-A" },
		});
		await finishTurn(main, "收到：列出文件。我是测试用的假助手。", "sess-A");
		const events = await eventsOf(alice.client, dm);
		expect(messagesBy(events, ext.id).map((m) => m.payload.text)).toEqual([
			"收到：列出文件。我是测试用的假助手。",
		]);
		const [run] = await runsOf(main);
		expect(run).toMatchObject({
			agentId: ext.id,
			engine: "acp",
			state: "completed",
			taskId: null,
			externalSessionId: "sess-A",
			actingForId: alice.me.principal.id,
		});
		expect(run?.trigger).toMatch(/^event:\d+$/);
		const detail = await alice.client.request("GET", `/api/runs/${run?.id}`);
		const { logs } = RunResponseSchema.parse(await detail.json());
		expect(logs.map((l) => [l.kind, l.seq])).toEqual([
			["prompt", 1],
			["state", 2],
			["agent_text", 3],
		]);
		expect(logs.every((l) => l.taskId === null && l.runId === run?.id)).toBe(
			true,
		);
	});

	it("同一话题再发：同一外部会话（acp_prompt），又一次运行", async () => {
		await say(alice.client, dm, "再说一次");
		expect(downOf("acp_prompt", main).map((f) => f.prompt)).toEqual([
			"再说一次",
		]);
		await finishTurn(main, "第二轮", "sess-A");
		const runs = await runsOf(main);
		expect(runs.map((r) => r.externalSessionId)).toEqual(["sess-A", "sess-A"]);
		expect(downOf("acp_start", main)).toHaveLength(1);
	});

	it("另一个话题：另起一个 ACP 会话，两边的消息互不串", async () => {
		topicB = await newTopic(dm, "查日志");
		await sayIn(topicB, "看看昨天的日志");
		expect(downOf("acp_start", topicB).map((f) => f.prompt)).toEqual([
			"看看昨天的日志",
		]);
		await finishTurn(topicB, "日志里有两处报错", "sess-B");
		expect((await runsOf(topicB)).map((r) => r.externalSessionId)).toEqual([
			"sess-B",
		]);
		expect(
			(await runsOf(main)).every((r) => r.externalSessionId === "sess-A"),
		).toBe(true);
		const inB = messagesBy(
			await topicEventsOf(alice.client, dm, topicB),
			ext.id,
		);
		expect(inB.map((m) => m.payload.text)).toEqual(["日志里有两处报错"]);
		const inMain = messagesBy(await eventsOf(alice.client, dm), ext.id);
		expect(inMain.map((m) => m.payload.text)).not.toContain("日志里有两处报错");
		expect(inMain.every((m) => m.topicId === main)).toBe(true);
	});

	it("一轮进行中又来的消息排队，这一轮结束后才发出（各自一次运行）", async () => {
		await sayIn(topicB, "第三轮");
		await sayIn(topicB, "排队的话");
		expect(downOf("acp_prompt", topicB).map((f) => f.prompt)).toEqual([
			"第三轮",
		]);
		await finishTurn(topicB, "第三轮做完", "sess-B");
		expect(downOf("acp_prompt", topicB).at(-1)?.prompt).toBe("排队的话");
		await finishTurn(topicB, "排队的也做完", "sess-B");
		expect((await runsOf(topicB)).map((r) => r.state)).toEqual([
			"completed",
			"completed",
			"completed",
		]);
	});

	it("权限请求 → 审批卡片落在该话题（带运行、工具调用与选项）；所选选项原样回传", async () => {
		await sayIn(topicB, "#perm 写入 a.txt");
		const [run] = (await runsOf(topicB)).slice(-1);
		await device.up({
			t: "acp_permission",
			taskId: topicB,
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
			runId: run?.id,
			runnerId,
			capability: AGENT_ACP_CAPABILITY,
			toolCall: { title: "写入 a.txt", kind: "edit" },
		});
		expect(item.kind === "approval" && item.payload.taskId).toBeUndefined();
		const card = (await topicEventsOf(alice.client, dm, topicB)).find(
			(e) => e.type === "approval.requested",
		);
		expect(card).toMatchObject({ topicId: topicB });
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
			downOf("acp_permission_reply", topicB).find((f) => f.requestId === "p1"),
		);
		expect(reply.optionId).toBe("allow_always");
		const resolved = (await topicEventsOf(alice.client, dm, topicB)).find(
			(e) => e.type === "approval.resolved",
		);
		expect(resolved).toMatchObject({ topicId: topicB });
		await finishTurn(topicB, "已写入 a.txt", "sess-B");
	});

	it("10 分钟未处理视为拒绝（此处以短超时验证）：代为选拒绝类选项", async () => {
		externalSessions.options.approvalTimeoutMs = 100;
		await sayIn(topicB, "#perm 写入 late.txt");
		await device.up({
			t: "acp_permission",
			taskId: topicB,
			requestId: "p2",
			toolCall: { title: "写入 late.txt" },
			options: [
				{ optionId: "allow", name: "允许", kind: "allow_once" },
				{ optionId: "reject", name: "拒绝", kind: "reject_once" },
			],
		});
		const reply = await until("过期后回传", () =>
			downOf("acp_permission_reply", topicB).find((f) => f.requestId === "p2"),
		);
		externalSessions.options.approvalTimeoutMs = timeoutBefore;
		expect(reply.optionId).toBe("reject");
		await finishTurn(topicB, "没写", "sess-B");
	});
});

describe("任务 = 带状态的话题", () => {
	let topicC: string;
	let first: string;

	it("主线不能转为任务；话题里没有本人消息又不给目标 → 400", async () => {
		const onMain = await alice.client.request(
			"POST",
			`/api/topics/${main}/to-task`,
			{},
		);
		expect(onMain.status).toBe(400);
		topicC = await newTopic(dm, "整理文档");
		const empty = await alice.client.request(
			"POST",
			`/api/topics/${topicC}/to-task`,
			{},
		);
		expect(empty.status).toBe(400);
	});

	it("转为任务：目标取话题里本人最后一条消息，等本人处理；之后的运行服务于任务", async () => {
		await sayIn(topicC, "把 docs 里的文档整理一下");
		await finishTurn(topicC, "先看了一遍目录", "sess-C");
		const res = await alice.client.request(
			"POST",
			`/api/topics/${topicC}/to-task`,
			{},
		);
		expect(res.status).toBe(201);
		const created = TaskResponseSchema.parse(await res.json()).task;
		first = created.id;
		expect(created).toMatchObject({
			topicId: topicC,
			goal: "把 docs 里的文档整理一下",
			title: "整理文档",
			engine: "acp",
			state: "input_required",
		});
		const topic = (await topicsOf(alice.client, dm)).find(
			(t) => t.id === topicC,
		);
		expect(topic).toMatchObject({
			kind: "task",
			taskId: first,
			taskState: "input_required",
		});
		const again = await alice.client.request(
			"POST",
			`/api/topics/${topicC}/to-task`,
			{},
		);
		expect(again.status).toBe(409);

		await sayIn(topicC, "开始吧");
		expect(downOf("acp_prompt", topicC).at(-1)?.prompt).toBe("开始吧");
		expect((await task(alice.client, first)).state).toBe("working");
		await device.up({
			t: "acp_event",
			taskId: topicC,
			kind: "tool_result",
			payload: { title: "写入 index.md", ok: true, path: "index.md" },
		});
		await finishTurn(topicC, "整理好了，新增了 index.md", "sess-C");
		const t = await task(alice.client, first);
		expect(t).toMatchObject({
			state: "input_required",
			resultSummary: "整理好了，新增了 index.md",
			externalSessionId: "sess-C",
			artifacts: [{ kind: "file", label: "index.md", ref: "index.md" }],
		});
		const [run] = (await runsOf(topicC)).slice(-1);
		expect(run?.taskId).toBe(first);
	});

	it("任务的过程即其运行的记录：日志在任务内按 seq 连续", async () => {
		const res = await alice.client.request("GET", `/api/tasks/${first}/log`);
		const { items } = TaskLogResponseSchema.parse(await res.json());
		expect(items.map((l) => l.seq)).toEqual(items.map((_, i) => i + 1));
		expect(items[0]).toMatchObject({
			kind: "prompt",
			payload: { text: "把 docs 里的文档整理一下" },
		});
		expect(items.map((l) => l.kind)).toEqual(
			expect.arrayContaining(["agent_text", "tool_result", "state"]),
		);
		const [run] = (await runsOf(topicC)).slice(-1);
		expect(items.filter((l) => l.runId === run?.id).length).toBeGreaterThan(0);
	});

	it("完成：任务 completed，话题与它的 ACP 会话保留、可以接着聊（运行不再服务于任务）", async () => {
		const res = await alice.client.request(
			"POST",
			`/api/tasks/${first}/complete`,
		);
		expect(TaskResponseSchema.parse(await res.json()).task.state).toBe(
			"completed",
		);
		expect(downOf("acp_cancel", topicC)).toHaveLength(0);
		const again = await alice.client.request(
			"POST",
			`/api/tasks/${first}/complete`,
		);
		expect(again.status).toBe(409);
		const peek = await bob.client.request("GET", `/api/tasks/${first}`);
		expect(peek.status).toBe(404);
		const inTopic = await topicEventsOf(alice.client, dm, topicC);
		expect(inTopic.filter((e) => e.type === "task.ended").at(-1)).toMatchObject(
			{
				payload: { taskId: first, state: "completed" },
			},
		);

		await sayIn(topicC, "顺便问一下，index.md 放哪了？");
		expect(downOf("acp_prompt", topicC).at(-1)?.prompt).toBe(
			"顺便问一下，index.md 放哪了？",
		);
		await finishTurn(topicC, "在 docs 根目录", "sess-C");
		const [run] = (await runsOf(topicC)).slice(-1);
		expect(run).toMatchObject({ taskId: null, externalSessionId: "sess-C" });
		expect((await task(alice.client, first)).state).toBe("completed");
		expect(
			(await topicsOf(alice.client, dm)).find((t) => t.id === topicC),
		).toMatchObject({ kind: "task", taskState: "completed" });
	});

	it("再次交办：已结束任务的话题可以再转为任务；停止 → canceled 并打断这一轮", async () => {
		const res = await alice.client.request(
			"POST",
			`/api/topics/${topicC}/to-task`,
			{ goal: "再补一份目录说明" },
		);
		expect(res.status).toBe(201);
		const second = TaskResponseSchema.parse(await res.json()).task;
		expect(second.id).not.toBe(first);
		await scheduler.idle(dm);
		expect(downOf("acp_prompt", topicC).at(-1)?.prompt).toBe(
			"再补一份目录说明",
		);
		expect((await task(alice.client, second.id)).state).toBe("working");
		const cancel = await alice.client.request(
			"POST",
			`/api/tasks/${second.id}/cancel`,
		);
		expect(TaskResponseSchema.parse(await cancel.json()).task.state).toBe(
			"canceled",
		);
		expect(downOf("acp_interrupt", topicC)).toHaveLength(1);
		await device.up({
			t: "acp_turn_end",
			taskId: topicC,
			stopReason: "cancelled",
			sessionId: "sess-C",
		});
		const [run] = (await runsOf(topicC)).slice(-1);
		expect(run).toMatchObject({ state: "canceled", summary: "被新消息打断" });
	});

	it("新任务：新开一个任务话题，目标作为本人的第一条消息，起一个新的 ACP 会话", async () => {
		const res = await alice.client.request("POST", "/api/tasks", {
			conversationId: dm,
			goal: "另起炉灶",
		});
		expect(res.status).toBe(201);
		const created = TaskResponseSchema.parse(await res.json()).task;
		await scheduler.idle(dm);
		const topicId = created.topicId ?? "";
		expect(downOf("acp_start", topicId)[0]?.prompt).toBe("另起炉灶");
		expect((await task(alice.client, created.id)).state).toBe("working");
		await finishTurn(topicId, "开好头了", "sess-D");
		expect((await task(alice.client, created.id)).state).toBe("input_required");
		const elsewhere = await alice.client.request("POST", "/api/tasks", {
			conversationId: await openDm(alice.client, twin),
			goal: "x",
		});
		expect(elsewhere.status).toBe(201);
		const pair = await openDm(alice.client, bob.me.principal.id);
		const notOwn = await alice.client.request("POST", "/api/tasks", {
			conversationId: pair,
			goal: "x",
		});
		expect(notOwn.status).toBe(400);
		await scheduler.idle(await openDm(alice.client, twin));
	});

	it("归档话题：让设备终止它的 ACP 会话", async () => {
		const res = await alice.client.request("PATCH", `/api/topics/${topicC}`, {
			archived: true,
		});
		expect(res.status).toBe(200);
		expect(downOf("acp_cancel", topicC)).toHaveLength(1);
		const post = await alice.client.request(
			"POST",
			`/api/conversations/${dm}/messages`,
			{ text: "还在吗", topicId: topicC },
		);
		expect(post.status).toBe(400);
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

	it("为本人：在本人与它的私聊里新开任务话题并在那里交办，等这一轮结束，交回摘要", async () => {
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
		const topic = (await topicsOf(alice.client, dm)).find(
			(t) => t.id === start.taskId,
		);
		expect(topic).toMatchObject({ kind: "task", title: "整理一下文件" });
		const t = await task(alice.client, topic?.taskId ?? "");
		expect(t).toMatchObject({ conversationId: dm, requesterId: twin });
		await finishTurn(start.taskId, "整理好了三个文件", "sess-E");
		await scheduler.idle(own);
		const [reply] = messagesBy(await eventsOf(alice.client, own), twin);
		expect(reply?.payload.text).toBe("完成：整理好了三个文件");
		const [run] = await runsOf(start.taskId);
		expect(run?.trigger).toMatch(/^run:/);
	});
});

describe("维护", () => {
	it("Runner 重连：认得的会话槽接回，认不得的让它终止；以为在跑却不在的，这一轮判失败", async () => {
		await say(alice.client, dm, "丢失的这一轮");
		const unknown = crypto.randomUUID();
		const topicB = (await topicsOf(alice.client, dm)).find(
			(t) => t.title === "查日志",
		)?.id;
		await device.up({ ...HELLO, acpTasks: [unknown, topicB] });
		expect(downOf("acp_cancel", unknown)).toHaveLength(1);
		expect(downOf("acp_cancel", topicB)).toHaveLength(0);
		const [run] = (await runsOf(main)).slice(-1);
		expect(run).toMatchObject({ state: "failed", summary: LOST_SUMMARY });
		// 主线的会话已不在设备上：下一段话重新起会话。
		await say(alice.client, dm, "重新来");
		expect(downOf("acp_start", main).at(-1)?.prompt).toBe("重新来");
		await finishTurn(main, "好的", "sess-A2");
	});

	it("24 小时没有活动：任务自动完成，空闲的会话槽让设备终止", async () => {
		const s = scoped(alice.me.tenant.id);
		await s.executor
			.update(tasks)
			.set({ updatedAt: sql`now() - interval '25 hours'` })
			.where(s.where(tasks, eq(tasks.state, "input_required")));
		const later = new Date(Date.now() + SLOT_IDLE_MS + 60_000);
		expect(await externalSessions.sweepIdle(later)).toBeGreaterThanOrEqual(1);
		expect(downOf("acp_cancel", main).length).toBeGreaterThan(0);
	});

	it("吊销设备：进行中的这一轮失败；之后再发消息，外部助手在话题里说明不可用", async () => {
		await say(alice.client, dm, "最后一件事");
		const res = await alice.client.request(
			"DELETE",
			`/api/runners/${runnerId}`,
		);
		expect(res.status).toBe(204);
		const [run] = (await runsOf(main)).slice(-1);
		expect(run).toMatchObject({ state: "failed", summary: REVOKED_SUMMARY });
		await say(alice.client, dm, "设备没了还能干活吗");
		const last = messagesBy(await eventsOf(alice.client, dm), ext.id).at(-1);
		expect(last?.payload.text).toBe(REVOKED_SUMMARY);
	});
});
