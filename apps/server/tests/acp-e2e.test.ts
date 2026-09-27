/**
 * 集成（MOCK_LLM=1，ORGOS_DEV=1）：以子进程真实启动服务端、Runner 命令行与仓库内的 fake ACP agent，
 * 走完"任务与外部助手""话题与运行记录"的验收条：建外部助手 → 主线里交办（外部助手在主线回复，
 * 运行记录带外部会话 id）→ 子进程环境里没有 runner token 与服务器地址 → 另一个话题另起一个外部会话、
 * 同话题复用 → 权限请求走审批（卡片在该话题）、批准后文件落在工作目录 → 话题转为任务、再完成，
 * 日志 seq 连续；内置助手的交办生成 engine=builtin 任务；他人经分身交办时外部助手不可用；
 * 企业模式（默认）下 agent 子进程拿到网关地址与任务令牌、经网关调用的账记在这一轮的运行与任务名下，
 * 任务结束后同一话题沿用同一外部会话与令牌、话题归档即吊销；个人模式下不注入。
 */
import type { ChildProcess } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	AgentResponseSchema,
	CreatePairingCodeResponseSchema,
	type Event,
	EventsResponseSchema,
	MeResponseSchema,
	type Run,
	RunListResponseSchema,
	RunnerListResponseSchema,
	RunResponseSchema,
	type Task,
	TaskListResponseSchema,
	TaskLogResponseSchema,
	TaskResponseSchema,
	TopicListResponseSchema,
	TopicResponseSchema,
	WorkItemListResponseSchema,
} from "@orgos/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gatewayTokens, llmRequests } from "@/db/schema";
import { scoped } from "@/db/scope";
import { TEST_DATABASE_URL } from "../vitest.config";
import {
	FAKE_TEXT,
	type FakeUpstream,
	startFakeUpstream,
} from "./fake-upstream";
import {
	exited,
	type Http,
	type Person,
	person,
	runCli,
	type ServerProcess,
	startServer,
	until,
} from "./process-harness";

const PORT = 8935;
const BASE = `http://localhost:${PORT}`;

let server: ServerProcess;
let runner: ChildProcess | null = null;
let runnerLog = "";
let fakeLlm: FakeUpstream | null = null;
const FAKE_KEY = "sk-fake-e2e-upstream-3d9a";
let tmp: string;
let home: string;
let workspace: string;

beforeAll(async () => {
	tmp = await mkdtemp(path.join(tmpdir(), "orgos-acp-e2e-"));
	home = path.join(tmp, "home");
	workspace = path.join(tmp, "workspace");
	await mkdir(path.join(workspace, "proj"), { recursive: true });
	await writeFile(
		path.join(workspace, "proj", "calc.py"),
		"def add(a, b):\n\treturn a + b\n",
	);
	server = await startServer({
		port: PORT,
		databaseUrl: TEST_DATABASE_URL,
		env: { MOCK_LLM: "1", ORGOS_DEV: "1" },
	});
}, 30_000);

afterAll(async () => {
	await fakeLlm?.close();
	runner?.kill("SIGTERM");
	await Promise.all([runner ? exited(runner) : null, server?.stop()]);
	await rm(tmp, { recursive: true, force: true });
});

describe("外部助手（fake 适配器）全链路", () => {
	let alice: Person;
	let bob: Person;
	let runnerId: string;
	let token: string;
	let ext: { id: string; handle: string };
	let dm: string;
	let main: string;
	let topicB: string;
	let mainRun: Run;

	async function events(
		c: Http,
		id: string,
		topicId?: string,
	): Promise<Event[]> {
		const res = await c.request(
			"GET",
			`/api/conversations/${id}/events?limit=200${topicId ? `&topicId=${topicId}` : ""}`,
		);
		return EventsResponseSchema.parse(await res.json()).items;
	}

	async function myTasks(): Promise<Task[]> {
		const res = await alice.client.request("GET", "/api/tasks");
		return TaskListResponseSchema.parse(await res.json()).items;
	}

	async function taskById(id: string): Promise<Task> {
		const res = await alice.client.request("GET", `/api/tasks/${id}`);
		return TaskResponseSchema.parse(await res.json()).task;
	}

	/** 某话题的运行，最近的在前。 */
	async function runsIn(topicId: string): Promise<Run[]> {
		const res = await alice.client.request(
			"GET",
			`/api/runs?topicId=${topicId}`,
		);
		return RunListResponseSchema.parse(await res.json()).items;
	}

	async function post(text: string, topicId?: string) {
		const res = await alice.client.request(
			"POST",
			`/api/conversations/${dm}/messages`,
			{ text, ...(topicId ? { topicId } : {}) },
		);
		expect(res.status).toBe(201);
	}

	beforeAll(async () => {
		alice = await person(BASE, { name: "Alice" });
		bob = await person(BASE, {
			name: "Bob",
			inviteCode: alice.me.tenant.inviteCode,
		});
		const res = await alice.client.request(
			"POST",
			"/api/runners/pairing-codes",
		);
		const { code } = CreatePairingCodeResponseSchema.parse(await res.json());
		const pair = runCli(home, [
			"pair",
			code,
			"--server",
			BASE,
			"--name",
			"测试Mac",
		]);
		expect(await exited(pair)).toBe(0);
		const config = JSON.parse(
			await readFile(path.join(home, "runner.json"), "utf8"),
		) as { runnerId: string; token: string };
		runnerId = config.runnerId;
		token = config.token;
		// Runner 进程的环境里混进 token 与服务器地址：外部助手的子进程必须一个都看不到。
		runner = runCli(
			home,
			["serve", "--workspace", workspace, "--adapters", "fake"],
			{
				ORGOS_DEV: "1",
				ORGOS_RUNNER_TOKEN: token,
				ORGOS_SERVER_URL: BASE,
			},
		);
		runner.stderr?.on("data", (d: Buffer) => {
			runnerLog += d.toString();
		});
	}, 30_000);

	it("设备上报 agent.acp，探测后 fake 适配器可用", async () => {
		const online = await until("fake 可用", async () => {
			const res = await alice.client.request("GET", "/api/runners");
			const { items } = RunnerListResponseSchema.parse(await res.json());
			const r = items.find((x) => x.id === runnerId && x.status === "online");
			const acp = r?.capabilities.find((c) => c.name === "agent.acp");
			return acp?.adapters?.find((a) => a.id === "fake" && a.available)
				? r
				: null;
		});
		expect(online.workspace).toBeTruthy();
	}, 30_000);

	it("建外部助手：出现在代理组与会话列表", async () => {
		const res = await alice.client.request("POST", "/api/agents", {
			kind: "external",
			displayName: "测试助手",
			handle: `ext${Date.now().toString(36)}`,
			adapter: "fake",
			runnerId,
			workspace: "proj",
		});
		expect(res.status).toBe(201);
		const { agent } = AgentResponseSchema.parse(await res.json());
		ext = { id: agent.principal.id, handle: agent.principal.handle };
		const me = MeResponseSchema.parse(
			await (await alice.client.request("GET", "/api/me")).json(),
		);
		expect(me.agents.some((a) => a.principal.id === ext.id)).toBe(true);
		const convs = (await (
			await alice.client.request("GET", "/api/conversations")
		).json()) as {
			items: { conversation: { id: string }; members: { id: string }[] }[];
		};
		dm =
			convs.items.find((x) => x.members.some((m) => m.id === ext.id))
				?.conversation.id ?? "";
		expect(dm).not.toBe("");
		const topics = await alice.client.request(
			"GET",
			`/api/conversations/${dm}/topics`,
		);
		main =
			TopicListResponseSchema.parse(await topics.json()).items[0]?.id ?? "";
	});

	it("主线发“列出文件”：外部助手在主线里回复；运行记录带外部会话 id", async () => {
		await post("列出文件");
		const reply = await until("主线回复", async () =>
			(await events(alice.client, dm)).find(
				(e) =>
					e.type === "message.posted" &&
					e.actorId === ext.id &&
					e.payload.text.includes("我是测试用的假助手"),
			),
		);
		expect(reply.topicId).toBe(main);
		mainRun = await until("运行结束", async () => {
			const [r] = await runsIn(main);
			return r?.state === "completed" ? r : null;
		});
		expect(mainRun).toMatchObject({ engine: "acp", agentId: ext.id });
		expect(mainRun.externalSessionId).toMatch(/^fake-/);
	}, 30_000);

	it("fake agent 的进程环境里没有 runner token 与服务器地址", async () => {
		const res = await alice.client.request("GET", `/api/runs/${mainRun.id}`);
		const { logs } = RunResponseSchema.parse(await res.json());
		const text = logs
			.flatMap((l) =>
				l.kind === "agent_text" ? [(l.payload as { text: string }).text] : [],
			)
			.join("");
		const line = text.split("\n").find((l) => l.startsWith("环境变量："));
		expect(line).toBeDefined();
		const keys = (line ?? "").slice("环境变量：".length).split(",");
		expect(keys).toContain("PATH");
		expect(keys).not.toContain("ORGOS_RUNNER_TOKEN");
		expect(keys).not.toContain("ORGOS_SERVER_URL");
		expect(keys).not.toContain("ORGOS_RUNNER_HOME");
		expect(JSON.stringify(logs)).not.toContain(token);
		expect(runnerLog).not.toContain(token);
	});

	it("另一个话题另起一个外部会话；回到主线仍是原来的会话", async () => {
		const res = await alice.client.request(
			"POST",
			`/api/conversations/${dm}/topics`,
			{ title: "看代码" },
		);
		topicB = TopicResponseSchema.parse(await res.json()).topic.id;
		await post("看看 calc.py", topicB);
		const inB = await until("话题 B 的运行结束", async () => {
			const [r] = await runsIn(topicB);
			return r?.state === "completed" ? r : null;
		});
		expect(inB.externalSessionId).toMatch(/^fake-/);
		expect(inB.externalSessionId).not.toBe(mainRun.externalSessionId);
		await post("再看一眼");
		const again = await until("主线第二轮结束", async () => {
			const runs = await runsIn(main);
			return runs.length === 2 && runs[0]?.state === "completed"
				? runs[0]
				: null;
		});
		expect(again.externalSessionId).toBe(mainRun.externalSessionId);
		const mainTexts = (await events(alice.client, dm)).flatMap((e) =>
			e.type === "message.posted" && e.actorId === ext.id
				? [e.payload.text]
				: [],
		);
		expect(mainTexts.join("")).not.toContain("calc.py");
	}, 30_000);

	it("#perm 写入 a.txt：审批卡片落在该话题；批准后文件存在", async () => {
		await post("#perm 写入 a.txt", topicB);
		const item = await until("审批待办", async () => {
			const res = await alice.client.request(
				"GET",
				"/api/work-items?status=open",
			);
			return WorkItemListResponseSchema.parse(await res.json()).items.find(
				(w) => w.kind === "approval",
			);
		});
		const card = (await events(alice.client, dm, topicB)).find(
			(e) =>
				e.type === "approval.requested" && e.payload.workItemId === item.id,
		);
		expect(card?.topicId).toBe(topicB);
		const ok = await alice.client.request(
			"POST",
			`/api/work-items/${item.id}/resolve`,
			{ action: "approve" },
		);
		expect(ok.status).toBe(200);
		await until("文件落在工作目录", async () =>
			stat(path.join(workspace, "proj", "a.txt")).then(() => true),
		);
		await until("这一轮结束", async () => {
			const [r] = await runsIn(topicB);
			return r?.state === "completed";
		});
	}, 30_000);

	it("话题转为任务 → 交办一句 → 等本人；点“完成”→ completed；日志 seq 连续", async () => {
		const res = await alice.client.request(
			"POST",
			`/api/topics/${topicB}/to-task`,
			{ goal: "把 calc.py 的注释补全" },
		);
		expect(res.status).toBe(201);
		const created = TaskResponseSchema.parse(await res.json()).task;
		const waiting = await until("任务这一轮结束", async () => {
			const t = await taskById(created.id);
			return t.state === "input_required" ? t : null;
		});
		expect(waiting.resultSummary).toContain("收到：把 calc.py 的注释补全");
		const done = await alice.client.request(
			"POST",
			`/api/tasks/${created.id}/complete`,
		);
		expect(TaskResponseSchema.parse(await done.json()).task.state).toBe(
			"completed",
		);
		const log = await alice.client.request(
			"GET",
			`/api/tasks/${created.id}/log`,
		);
		const { items } = TaskLogResponseSchema.parse(await log.json());
		expect(items.length).toBeGreaterThan(3);
		expect(items.map((l) => l.seq)).toEqual(items.map((_, i) => i + 1));
	}, 30_000);

	it("#delegate:<执行助手> 整理周报 → engine=builtin 的任务", async () => {
		const twin =
			alice.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
		const ops = alice.me.agents.find(
			(a) => a.role === "specialist" && a.engine !== "acp",
		)?.principal.handle;
		const res = await alice.client.request("POST", "/api/conversations", {
			kind: "dm",
			withPrincipalId: twin,
		});
		const own = ((await res.json()) as { conversation: { id: string } })
			.conversation.id;
		await alice.client.request("POST", `/api/conversations/${own}/messages`, {
			text: `#delegate:${ops} 整理周报`,
		});
		const t = await until("builtin 任务", async () => {
			const x = (await myTasks()).find((k) => k.goal === "整理周报");
			return x?.state === "completed" ? x : null;
		});
		expect(t.engine).toBe("builtin");
	}, 30_000);

	it("bob 经 alice 的分身交办：外部助手不可用（无权限），不起任务", async () => {
		const res = await bob.client.request("POST", "/api/conversations", {
			kind: "dm",
			withPrincipalId: alice.me.principal.id,
		});
		const pair = ((await res.json()) as { conversation: { id: string } })
			.conversation.id;
		await bob.client.request("POST", `/api/conversations/${pair}/messages`, {
			text: `#delegate:${ext.handle} 帮我看看代码`,
			askTwin: true,
		});
		const twin =
			alice.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
		const reply = await until("分身回复", async () =>
			(await events(bob.client, pair)).find(
				(e) => e.type === "message.posted" && e.actorId === twin,
			),
		);
		expect(reply.type === "message.posted" && reply.payload.text).toContain(
			"无权限",
		);
		expect(
			(await myTasks()).filter((k) => k.goal.includes("帮我看看代码")),
		).toHaveLength(0);
	}, 30_000);

	function envKeysOf(text: string): string[] {
		const line = text.split("\n").find((l) => l.startsWith("环境变量："));
		return (line ?? "").slice("环境变量：".length).split(",");
	}

	async function lastReply(topicId?: string): Promise<string> {
		const texts = (await events(alice.client, dm, topicId)).flatMap((e) =>
			e.type === "message.posted" && e.actorId === ext.id
				? [e.payload.text]
				: [],
		);
		return texts.at(-1) ?? "";
	}

	it("企业模式（默认）：agent 子进程拿到网关地址、任务令牌与模型；#llm 经网关，记在这一轮的运行名下", async () => {
		const res = await alice.client.request("GET", `/api/runs/${mainRun.id}`);
		const { logs } = RunResponseSchema.parse(await res.json());
		const keys = envKeysOf(
			logs
				.flatMap((l) =>
					l.kind === "agent_text" ? [(l.payload as { text: string }).text] : [],
				)
				.join(""),
		);
		expect(keys).toEqual(
			expect.arrayContaining([
				"OPENAI_BASE_URL",
				"OPENAI_API_KEY",
				"OPENAI_MODEL",
			]),
		);
		fakeLlm = await startFakeUpstream({
			openai: FAKE_KEY,
			anthropic: "unused",
		});
		const created = await alice.client.request("POST", "/api/model-providers", {
			name: "deepseek",
			preset: "deepseek",
			endpoints: { openai: `${fakeLlm.url}/openai` },
			apiKey: FAKE_KEY,
			exposedModels: ["deepseek-v4-flash"],
		});
		expect(created.status).toBe(201);
		const before = (await runsIn(main)).length;
		await post("#llm 你好");
		const run = await until("主线这一轮结束", async () => {
			const runs = await runsIn(main);
			return runs.length > before && runs[0]?.state === "completed"
				? runs[0]
				: null;
		});
		expect(await lastReply()).toContain(`模型说：${FAKE_TEXT.join("")}`);
		expect(fakeLlm.requests.at(-1)?.body.model).toBe("deepseek-v4-flash");
		const rows = await scoped(alice.me.tenant.id).select(
			llmRequests,
			eq(llmRequests.runId, run.id),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			agentId: ext.id,
			onBehalfOfId: alice.me.principal.id,
			conversationId: dm,
			protocolIn: "openai",
			protocolOut: "openai",
			provider: "deepseek",
			httpStatus: 200,
		});
		expect(rows[0]?.costMicroUsd).toBeGreaterThan(0);
	}, 30_000);

	it("任务话题：调用记在任务名下；任务结束后同一话题沿用同一外部会话与令牌，调用不再记在该任务名下；话题归档即吊销", async () => {
		const res = await alice.client.request("POST", "/api/tasks", {
			conversationId: dm,
			goal: "#llm 总结一下",
		});
		expect(res.status).toBe(201);
		const { task } = TaskResponseSchema.parse(await res.json());
		const topicId = task.topicId ?? "";
		const waiting = await until("任务这一轮结束", async () => {
			const t = await taskById(task.id);
			return t.state === "input_required" ? t : null;
		});
		expect(waiting.resultSummary).toContain("模型说：");
		const rows = await scoped(alice.me.tenant.id).select(
			llmRequests,
			eq(llmRequests.taskId, task.id),
		);
		expect(rows.map((r) => r.agentId)).toEqual([ext.id]);
		const [first] = await runsIn(topicId);
		await alice.client.request("POST", `/api/tasks/${task.id}/complete`);
		await post("#llm 再来一次", topicId);
		const second = await until("任务结束后的一轮", async () => {
			const [r] = await runsIn(topicId);
			return r && r.id !== first?.id && r.state === "completed" ? r : null;
		});
		expect(await lastReply(topicId)).toContain("模型说：");
		expect(second.externalSessionId).toBe(first?.externalSessionId);
		const s = scoped(alice.me.tenant.id);
		const secondRows = await s.select(
			llmRequests,
			eq(llmRequests.runId, second.id),
		);
		expect(secondRows).toHaveLength(1);
		expect(secondRows[0]?.taskId).toBeNull();
		const tokens = await s.select(
			gatewayTokens,
			eq(gatewayTokens.topicId, topicId),
		);
		expect(tokens).toHaveLength(1);
		expect(tokens[0]?.revokedAt).toBeNull();
		const archived = await alice.client.request(
			"PATCH",
			`/api/topics/${topicId}`,
			{ archived: true },
		);
		expect(archived.status).toBe(200);
		const [revoked] = await s.select(
			gatewayTokens,
			eq(gatewayTokens.topicId, topicId),
		);
		expect(revoked?.revokedAt).not.toBeNull();
	}, 30_000);

	it("个人模式（组织允许时）：不注入，agent 子进程看不到网关地址与令牌", async () => {
		const set = await alice.client.request("PATCH", "/api/tenant/settings", {
			allowPersonalExternal: true,
			externalAgentMode: "personal",
		});
		expect(set.status).toBe(200);
		try {
			const res = await alice.client.request(
				"POST",
				`/api/conversations/${dm}/topics`,
				{ title: "个人模式" },
			);
			const topicC = TopicResponseSchema.parse(await res.json()).topic.id;
			await post("#llm 你好", topicC);
			await until("个人模式这一轮结束", async () => {
				const [r] = await runsIn(topicC);
				return r?.state === "completed";
			});
			const reply = await lastReply(topicC);
			expect(reply).toContain("没有注入网关");
			const keys = envKeysOf(reply);
			expect(keys).toContain("PATH");
			expect(keys).not.toContain("OPENAI_BASE_URL");
		} finally {
			await alice.client.request("PATCH", "/api/tenant/settings", {
				allowPersonalExternal: false,
			});
		}
	}, 30_000);
});
