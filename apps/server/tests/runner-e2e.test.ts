/**
 * 集成（MOCK_LLM=1）：以子进程真实启动服务端与 Runner 命令行，走完 R 的全链路——
 * pair 写 0600 的 runner.json、serve 连上并声明能力、执行助手列目录 / 执行命令（批准与拒绝）/
 * 越界读被拒、吊销后连接以 4003 断开且重连握手被 401 拒绝。
 * 临时 ORGOS_RUNNER_HOME 与工作目录，结束后清理。
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
	CreateConversationResponseSchema,
	CreatePairingCodeResponseSchema,
	type Event,
	EventsResponseSchema,
	RunnerListResponseSchema,
	type WorkItem,
	WorkItemListResponseSchema,
} from "@orgos/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "../vitest.config";
import {
	exited,
	type Person,
	person,
	runCli,
	type ServerProcess,
	startServer,
	until,
	wsHandshakeStatus,
} from "./process-harness";

const PORT = 8934;
const BASE = `http://localhost:${PORT}`;

let server: ServerProcess;
let runner: ChildProcess | null = null;
let runnerLog = "";
let tmp: string;
let home: string;
let workspace: string;

beforeAll(async () => {
	tmp = await mkdtemp(path.join(tmpdir(), "orgos-runner-e2e-"));
	home = path.join(tmp, "home");
	workspace = path.join(tmp, "workspace");
	await mkdir(workspace);
	await writeFile(path.join(workspace, "readme.md"), "# 测试工作目录\n");
	await writeFile(path.join(workspace, "todo.txt"), "买牛奶\n");
	server = await startServer({
		port: PORT,
		databaseUrl: TEST_DATABASE_URL,
		env: { MOCK_LLM: "1" },
	});
}, 30_000);

afterAll(async () => {
	runner?.kill("SIGTERM");
	await Promise.all([runner ? exited(runner) : null, server?.stop()]);
	await rm(tmp, { recursive: true, force: true });
});

describe("真实 Runner 子进程", () => {
	let alice: Person;
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
		alice = await person(BASE, { name: "Alice" });
		ops =
			alice.me.agents.find((a) => a.role === "specialist")?.principal.id ?? "";
	}, 30_000);

	it("pair：写入 0600 的 runner.json", async () => {
		const res = await alice.client.request(
			"POST",
			"/api/runners/pairing-codes",
		);
		const { code } = CreatePairingCodeResponseSchema.parse(await res.json());
		const child = runCli(home, [
			"pair",
			code,
			"--server",
			BASE,
			"--name",
			"测试Mac",
		]);
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
		const again = runCli(home, ["pair", code, "--server", BASE, "--name", "x"]);
		expect(await exited(again)).toBe(1);
	}, 30_000);

	it("serve：连上后在线并声明四项设备能力与 agent.acp；绑定执行助手", async () => {
		runner = runCli(home, [
			"serve",
			"--workspace",
			workspace,
			"--adapters",
			"none",
		]);
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
			["agent.acp", "exec"],
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
			BASE,
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
