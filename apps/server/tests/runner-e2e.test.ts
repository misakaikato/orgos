/**
 * 集成（MOCK_LLM=1）：以子进程真实启动服务端与 Runner 命令行，走完 R 的全链路——
 * pair 写 0600 的 runner.json、serve 连上并声明能力、执行助手列目录 / 执行命令（批准与拒绝）/
 * 越界读被拒、吊销后连接以 4003 断开且重连握手被 401 拒绝。
 * 临时 ORGOS_RUNNER_HOME 与工作目录，结束后清理。
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
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CreateConversationResponseSchema,
	CreatePairingCodeResponseSchema,
	type Event,
	EventsResponseSchema,
	MeResponseSchema,
	RunnerListResponseSchema,
	type WorkItem,
	WorkItemListResponseSchema,
} from "@orgos/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "../vitest.config";

const PORT = 8934;
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
			: { mode: "create", orgName: `e2e-${handle}`, displayName: name, handle },
	);
	expect(onboard.status).toBe(201);
	const me = MeResponseSchema.parse(
		await (await client.request("GET", "/api/me")).json(),
	);
	return { client, me };
}

/** 发一次 WS 升级握手，返回 HTTP 状态码（101 表示升级成功）。 */
function wsHandshakeStatus(p: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(`${BASE}${p}`, {
			headers: {
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-version": "13",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			},
		});
		req.on("upgrade", (res, socket) => {
			socket.destroy();
			resolve(res.statusCode ?? 101);
		});
		req.on("response", (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end();
	});
}

function runCli(args: string[]): ChildProcess {
	return spawn("bun", ["run", "src/main.ts", ...args], {
		cwd: RUNNER_DIR,
		env: {
			...process.env,
			ORGOS_RUNNER_HOME: home,
			NO_PROXY,
			no_proxy: NO_PROXY,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function exited(child: ChildProcess): Promise<number | null> {
	return new Promise((r) => child.once("exit", (code) => r(code)));
}

beforeAll(async () => {
	tmp = await mkdtemp(path.join(tmpdir(), "orgos-runner-e2e-"));
	home = path.join(tmp, "home");
	workspace = path.join(tmp, "workspace");
	await mkdir(workspace);
	await writeFile(path.join(workspace, "readme.md"), "# 测试工作目录\n");
	await writeFile(path.join(workspace, "todo.txt"), "买牛奶\n");
	server = spawn("bun", ["src/serve.ts"], {
		cwd: SERVER_DIR,
		env: {
			...process.env,
			PORT: String(PORT),
			DATABASE_URL: TEST_DATABASE_URL,
			BETTER_AUTH_URL: BASE,
			MOCK_LLM: "1",
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

describe("真实 Runner 子进程", () => {
	let alice: Awaited<ReturnType<typeof person>>;
	let ops: string;
	let dm: string;
	let token: string;
	let runnerId: string;

	async function events(): Promise<Event[]> {
		const res = await alice.client.request(
			"GET",
			`/api/conversations/${dm}/events?limit=200`,
		);
		return EventsResponseSchema.parse(await res.json()).items;
	}

	async function replyAfter(text: string): Promise<string> {
		const before = (await events()).length;
		await alice.client.request("POST", `/api/conversations/${dm}/messages`, {
			text,
		});
		return until(`回复 ${text}`, async () => {
			const after = (await events()).slice(before);
			const reply = after.find(
				(e) => e.type === "message.posted" && e.actorId === ops,
			);
			return reply?.type === "message.posted" ? reply.payload.text : null;
		});
	}

	async function openApproval(): Promise<WorkItem> {
		return until("审批待办", async () => {
			const res = await alice.client.request(
				"GET",
				"/api/work-items?status=open",
			);
			return WorkItemListResponseSchema.parse(await res.json()).items.find(
				(w) => w.kind === "approval",
			);
		});
	}

	beforeAll(async () => {
		alice = await person("Alice");
		ops =
			alice.me.agents.find((a) => a.role === "specialist")?.principal.id ?? "";
	}, 30_000);

	it("pair：写入 0600 的 runner.json", async () => {
		const res = await alice.client.request(
			"POST",
			"/api/runners/pairing-codes",
		);
		const { code } = CreatePairingCodeResponseSchema.parse(await res.json());
		const child = runCli(["pair", code, "--server", BASE, "--name", "测试Mac"]);
		expect(await exited(child)).toBe(0);
		const file = path.join(home, "runner.json");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const config = JSON.parse(await readFile(file, "utf8")) as {
			server: string;
			runnerId: string;
			token: string;
		};
		expect(config.server).toBe(BASE);
		token = config.token;
		runnerId = config.runnerId;
		const again = runCli(["pair", code, "--server", BASE, "--name", "x"]);
		expect(await exited(again)).toBe(1);
	}, 30_000);

	it("serve：连上后在线并声明四项能力；绑定执行助手", async () => {
		runner = runCli(["serve", "--workspace", workspace]);
		runner.stderr?.on("data", (d: Buffer) => {
			runnerLog += d.toString();
		});
		const online = await until("设备在线", async () => {
			const res = await alice.client.request("GET", "/api/runners");
			const { items } = RunnerListResponseSchema.parse(await res.json());
			return items.find((r) => r.id === runnerId && r.status === "online");
		});
		expect(online.capabilities.map((c) => [c.name, c.risk])).toEqual([
			["fs.list", "read"],
			["fs.read", "read"],
			["fs.write", "write"],
			["shell.exec", "exec"],
		]);
		expect(runnerLog).not.toContain(token);
		const bound = await alice.client.request("PATCH", `/api/agents/${ops}`, {
			runnerId,
		});
		expect(bound.status).toBe(200);
		const res = await alice.client.request("POST", "/api/conversations", {
			kind: "dm",
			withPrincipalId: ops,
		});
		dm = CreateConversationResponseSchema.parse(await res.json()).conversation
			.id;
	}, 30_000);

	it("#ls . 得到目录列表；#read 越界被拒", async () => {
		const list = await replyAfter("#ls .");
		expect(list).toContain("readme.md");
		expect(list).toContain("todo.txt");
		const read = await replyAfter("#read ../../etc/passwd");
		expect(read).toContain("超出工作目录");
		expect(read).not.toContain("root:");
	}, 30_000);

	it("#exec 批准后回显；拒绝后不执行", async () => {
		const before = (await events()).length;
		await alice.client.request("POST", `/api/conversations/${dm}/messages`, {
			text: "#exec echo hi > hi.txt; echo hi",
		});
		const item = await openApproval();
		const ok = await alice.client.request(
			"POST",
			`/api/work-items/${item.id}/resolve`,
			{ action: "approve" },
		);
		expect(ok.status).toBe(200);
		const reply = await until("批准后的回复", async () => {
			const e = (await events())
				.slice(before)
				.find((x) => x.type === "message.posted" && x.actorId === ops);
			return e?.type === "message.posted" ? e.payload.text : null;
		});
		expect(reply).toContain("hi");
		expect(await readFile(path.join(workspace, "hi.txt"), "utf8")).toBe("hi\n");

		const before2 = (await events()).length;
		await alice.client.request("POST", `/api/conversations/${dm}/messages`, {
			text: "#exec echo no > no.txt",
		});
		const denied = await openApproval();
		await alice.client.request("POST", `/api/work-items/${denied.id}/resolve`, {
			action: "deny",
		});
		const reply2 = await until("拒绝后的回复", async () => {
			const e = (await events())
				.slice(before2)
				.find((x) => x.type === "message.posted" && x.actorId === ops);
			return e?.type === "message.posted" ? e.payload.text : null;
		});
		expect(reply2).toContain("拒绝");
		await expect(stat(path.join(workspace, "no.txt"))).rejects.toThrow();
	}, 30_000);

	it("吊销：Runner 的连接以 4003 关闭，之后的握手被 401 拒绝", async () => {
		const res = await alice.client.request(
			"DELETE",
			`/api/runners/${runnerId}`,
		);
		expect(res.status).toBe(204);
		await until("Runner 收到 4003", async () => runnerLog.includes("4003"));
		const handshake = await wsHandshakeStatus(
			`/runner/ws?token=${encodeURIComponent(token)}`,
		);
		expect(handshake).toBe(401);
		const logLen = runnerLog.length;
		await until(
			"Runner 重连被拒",
			async () => /ws\.disconnected/.test(runnerLog.slice(logLen)),
			10_000,
		);
		const list = RunnerListResponseSchema.parse(
			await (await alice.client.request("GET", "/api/runners")).json(),
		);
		expect(list.items).toEqual([]);
	}, 30_000);
});
