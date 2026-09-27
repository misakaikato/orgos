/**
 * 集成（MOCK_LLM=1，ORGOS_DEV=1）：以子进程真实启动服务端、Runner 命令行与仓库内的 fake ACP agent，
 * 走完规格"任务与外部助手"验收条：建外部助手 → 私聊交办（working → input_required，卡片摘要含回复）→
 * 追问复用同一外部会话 → 权限请求走审批、批准后文件落在工作目录、任务回到 working → 完成 →
 * 新任务 → 日志 seq 连续 → 子进程环境里没有 runner token 与服务器地址；
 * 内置助手的交办生成 engine=builtin 任务；他人经分身交办时外部助手不可用。
 */
import { type ChildProcess, spawn } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import {
	AgentResponseSchema,
	CreatePairingCodeResponseSchema,
	type Event,
	EventsResponseSchema,
	MeResponseSchema,
	RunnerListResponseSchema,
	type Task,
	TaskListResponseSchema,
	TaskLogResponseSchema,
	TaskResponseSchema,
	WorkItemListResponseSchema,
} from "@orgos/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "../vitest.config";

const PORT = 8935;
const BASE = `http://localhost:${PORT}`;
const SERVER_DIR = fileURLToPath(new URL("../", import.meta.url));
const RUNNER_DIR = path.resolve(SERVER_DIR, "../runner");
const NO_PROXY = "localhost,127.0.0.1";

let server: ChildProcess;
let runner: ChildProcess | null = null;
let runnerLog = "";
let tmp: string;
let home: string;
let workspace: string;

type Http = {
	request(method: string, p: string, body?: unknown): Promise<Response>;
};

function http(cookie = ""): Http {
	return {
		request: (method, p, body) =>
			fetch(`${BASE}${p}`, {
				method,
				headers: {
					"content-type": "application/json",
					origin: BASE,
					...(cookie ? { cookie } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
	};
}

async function until<T>(
	what: string,
	fn: () => Promise<T | null | undefined | false>,
	timeoutMs = 15_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn().catch(() => null);
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

async function person(name: string, inviteCode?: string) {
	const email = `${name.toLowerCase()}-${Date.now()}@orgos.test`;
	const anon = http();
	await anon.request("POST", "/api/auth/sign-up/email", {
		email,
		password: "test-password-123",
		name,
	});
	const res = await anon.request("POST", "/api/auth/sign-in/email", {
		email,
		password: "test-password-123",
	});
	const cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
	const client = http(cookie);
	const handle = `${name.toLowerCase()}${Date.now().toString(36)}`;
	const onboard = await client.request(
		"POST",
		"/api/onboarding",
		inviteCode
			? { mode: "join", inviteCode, displayName: name, handle }
			: { mode: "create", orgName: `acp-${handle}`, displayName: name, handle },
	);
	expect(onboard.status).toBe(201);
	const me = MeResponseSchema.parse(
		await (await client.request("GET", "/api/me")).json(),
	);
	return { client, me };
}

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
	return spawn("bun", ["run", "src/main.ts", ...args], {
		cwd: RUNNER_DIR,
		env: {
			...process.env,
			ORGOS_RUNNER_HOME: home,
			ORGOS_DEV: "1",
			NO_PROXY,
			no_proxy: NO_PROXY,
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function exited(child: ChildProcess): Promise<number | null> {
	return new Promise((r) => child.once("exit", (code) => r(code)));
}

beforeAll(async () => {
	tmp = await mkdtemp(path.join(tmpdir(), "orgos-acp-e2e-"));
	home = path.join(tmp, "home");
	workspace = path.join(tmp, "workspace");
	await mkdir(path.join(workspace, "proj"), { recursive: true });
	await writeFile(
		path.join(workspace, "proj", "calc.py"),
		"def add(a, b):\n\treturn a + b\n",
	);
	server = spawn("bun", ["src/serve.ts"], {
		cwd: SERVER_DIR,
		env: {
			...process.env,
			PORT: String(PORT),
			DATABASE_URL: TEST_DATABASE_URL,
			BETTER_AUTH_URL: BASE,
			MOCK_LLM: "1",
			ORGOS_DEV: "1",
			NO_PROXY,
			no_proxy: NO_PROXY,
		},
		stdio: ["ignore", "ignore", "inherit"],
	});
	await until("服务端启动", async () => (await fetch(`${BASE}/healthz`)).ok);
}, 30_000);

afterAll(async () => {
	runner?.kill("SIGTERM");
	server?.kill("SIGTERM");
	await Promise.all(
		[runner, server].flatMap((c) =>
			c && c.exitCode === null ? [exited(c)] : [],
		),
	);
	await rm(tmp, { recursive: true, force: true });
});

describe("外部助手（fake 适配器）全链路", () => {
	let alice: Awaited<ReturnType<typeof person>>;
	let bob: Awaited<ReturnType<typeof person>>;
	let runnerId: string;
	let token: string;
	let ext: { id: string; handle: string };
	let dm: string;
	let first: Task;

	async function events(c: Http, id: string): Promise<Event[]> {
		const res = await c.request(
			"GET",
			`/api/conversations/${id}/events?limit=200`,
		);
		return EventsResponseSchema.parse(await res.json()).items;
	}

	async function tasksIn(id: string): Promise<Task[]> {
		const res = await alice.client.request(
			"GET",
			`/api/tasks?conversationId=${id}`,
		);
		return TaskListResponseSchema.parse(await res.json()).items;
	}

	async function taskById(id: string): Promise<Task> {
		const res = await alice.client.request("GET", `/api/tasks/${id}`);
		return TaskResponseSchema.parse(await res.json()).task;
	}

	async function post(text: string) {
		const res = await alice.client.request(
			"POST",
			`/api/conversations/${dm}/messages`,
			{ text },
		);
		expect(res.status).toBe(201);
	}

	/** 该任务在会话里经历过的状态（task.updated / task.ended 的顺序）。 */
	async function statesOf(taskId: string): Promise<string[]> {
		return (await events(alice.client, dm)).flatMap((e) =>
			(e.type === "task.updated" || e.type === "task.ended") &&
			e.payload.taskId === taskId
				? [e.payload.state]
				: [],
		);
	}

	beforeAll(async () => {
		alice = await person("Alice");
		bob = await person("Bob", alice.me.tenant.inviteCode);
		const res = await alice.client.request(
			"POST",
			"/api/runners/pairing-codes",
		);
		const { code } = CreatePairingCodeResponseSchema.parse(await res.json());
		const pair = runCli(["pair", code, "--server", BASE, "--name", "测试Mac"]);
		expect(await exited(pair)).toBe(0);
		const config = JSON.parse(
			await readFile(path.join(home, "runner.json"), "utf8"),
		) as { runnerId: string; token: string };
		runnerId = config.runnerId;
		token = config.token;
		// Runner 进程的环境里混进 token 与服务器地址：外部助手的子进程必须一个都看不到。
		runner = runCli(["serve", "--workspace", workspace, "--adapters", "fake"], {
			ORGOS_RUNNER_TOKEN: token,
			ORGOS_SERVER_URL: BASE,
		});
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
	});

	it("私聊发“列出文件”：task.created，working → input_required，摘要含回复", async () => {
		await post("列出文件");
		first = await until("第一轮结束", async () => {
			const [t] = await tasksIn(dm);
			return t?.state === "input_required" ? t : null;
		});
		expect(first).toMatchObject({ engine: "acp", adapter: "fake" });
		expect(first.resultSummary).toContain("我是测试用的假助手");
		expect(first.externalSessionId).toMatch(/^fake-/);
		const evts = await events(alice.client, dm);
		expect(
			evts.some(
				(e) => e.type === "task.created" && e.payload.taskId === first.id,
			),
		).toBe(true);
		expect(await statesOf(first.id)).toEqual(["working", "input_required"]);
	}, 30_000);

	it("fake agent 的进程环境里没有 runner token 与服务器地址", async () => {
		const res = await alice.client.request("GET", `/api/tasks/${first.id}/log`);
		const { items } = TaskLogResponseSchema.parse(await res.json());
		const text = items
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
		expect(JSON.stringify(items)).not.toContain(token);
		expect(runnerLog).not.toContain(token);
	});

	it("再发一条：同一任务、同一外部会话", async () => {
		await post("再看一眼");
		const again = await until("第二轮结束", async () => {
			const t = await taskById(first.id);
			const log = await alice.client.request(
				"GET",
				`/api/tasks/${first.id}/log`,
			);
			const { items } = TaskLogResponseSchema.parse(await log.json());
			const done = items.some(
				(l) =>
					l.kind === "agent_text" &&
					(l.payload as { text: string }).text.includes("收到：再看一眼"),
			);
			return done && t.state === "input_required" ? t : null;
		});
		expect(await tasksIn(dm)).toHaveLength(1);
		expect(again.externalSessionId).toBe(first.externalSessionId);
	}, 30_000);

	it("#perm 写入 a.txt：审批待办、awaiting_approval；批准后文件存在、回到 working", async () => {
		await post("#perm 写入 a.txt");
		const item = await until("审批待办", async () => {
			const res = await alice.client.request(
				"GET",
				"/api/work-items?status=open",
			);
			return WorkItemListResponseSchema.parse(await res.json()).items.find(
				(w) => w.kind === "approval",
			);
		});
		expect(item.kind === "approval" && item.payload.taskId).toBe(first.id);
		expect((await taskById(first.id)).state).toBe("awaiting_approval");
		const ok = await alice.client.request(
			"POST",
			`/api/work-items/${item.id}/resolve`,
			{ action: "approve" },
		);
		expect(ok.status).toBe(200);
		await until("文件落在工作目录", async () =>
			stat(path.join(workspace, "proj", "a.txt")).then(() => true),
		);
		await until(
			"这一轮结束",
			async () => (await taskById(first.id)).state === "input_required",
		);
		const states = await statesOf(first.id);
		const at = states.indexOf("awaiting_approval");
		expect(at).toBeGreaterThan(0);
		expect(states[at + 1]).toBe("working");
		const t = await taskById(first.id);
		expect(t.artifacts.map((a) => a.ref)).toContain("a.txt");
	}, 30_000);

	it("点“完成”→ completed；“新任务”→ 新 taskId；日志 seq 连续", async () => {
		const done = await alice.client.request(
			"POST",
			`/api/tasks/${first.id}/complete`,
		);
		expect(TaskResponseSchema.parse(await done.json()).task.state).toBe(
			"completed",
		);
		const res = await alice.client.request("POST", "/api/tasks", {
			conversationId: dm,
			goal: "新的一件事",
		});
		expect(res.status).toBe(201);
		const next = TaskResponseSchema.parse(await res.json()).task;
		expect(next.id).not.toBe(first.id);
		const second = await until("新任务第一轮结束", async () => {
			const t = await taskById(next.id);
			return t.state === "input_required" ? t : null;
		});
		expect(second.externalSessionId).not.toBe(first.externalSessionId);
		for (const id of [first.id, next.id]) {
			const log = await alice.client.request("GET", `/api/tasks/${id}/log`);
			const { items } = TaskLogResponseSchema.parse(await log.json());
			expect(items.length).toBeGreaterThan(3);
			expect(items.map((l) => l.seq)).toEqual(items.map((_, i) => i + 1));
		}
		await alice.client.request("POST", `/api/tasks/${next.id}/complete`);
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
			const [x] = await tasksIn(own);
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
		expect(await tasksIn(dm)).toHaveLength(2);
	}, 30_000);
});
