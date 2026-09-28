/**
 * 集成：设备配对（配对码过期 / 已用 / 正确、只存哈希）、我的设备、吊销（4003 与之后的 401）、
 * 代理只能绑本人的设备；RunnerHub 的并行、超时、离线与连接替换。
 *
 * node 下的 vitest 没有 Bun 的升级能力：WS 连接直接调用 `/runner/ws` 路由所用的 runnerWsEvents，
 * 以 hono 的 WSContext 包一个假连接。真实 Runner 子进程的全链路见 runner-e2e.test.ts。
 */
import {
	type AgentResponse,
	AgentResponseSchema,
	CreatePairingCodeResponseSchema,
	deviceCapabilityList,
	ErrorBodySchema,
	PAIRING_CODE_RE,
	PairRunnerResponseSchema,
	RUNNER_WS_CLOSE,
	type RunnerDown,
	RunnerListResponseSchema,
} from "@orgos/protocol";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pairingCodes, runners } from "@/db/schema";
import { scoped } from "@/db/scope";
import {
	OFFLINE_TEXT,
	RunnerHub,
	type RunnerSocket,
	runnerHub,
} from "@/realtime/runner-hub";
import { authenticateRunner } from "@/realtime/runner-ws";
import { createPairingCode, hashSecret } from "@/services/runners";
import { captureFrames } from "./agent-helpers";
import { anonymous, type Client, createTeam, type TeamMember } from "./helpers";
import { connectRunner, HELLO } from "./runner-helpers";

let alice: TeamMember;
let bob: TeamMember;
let dave: TeamMember;

beforeAll(async () => {
	[alice, bob] = (await createTeam(["Alice", "Bob"])) as [
		TeamMember,
		TeamMember,
	];
	[dave] = (await createTeam(["Dave"])) as [TeamMember];
});

async function newCode(c: Client): Promise<string> {
	const res = await c.request("POST", "/api/runners/pairing-codes");
	expect(res.status).toBe(201);
	return CreatePairingCodeResponseSchema.parse(await res.json()).code;
}

function pair(code: string, name = "测试机", via?: "desktop" | "cli") {
	return anonymous.request("POST", "/api/runners/pair", {
		code,
		name,
		os: "macOS arm64",
		...(via ? { via } : {}),
	});
}

async function pairNew(
	c: Client,
	name = "测试机",
): Promise<{ runnerId: string; token: string }> {
	const res = await pair(await newCode(c), name);
	expect(res.status).toBe(201);
	return PairRunnerResponseSchema.parse(await res.json());
}

async function expectInvalid(res: Response) {
	expect(res.status).toBe(400);
	expect(ErrorBodySchema.parse(await res.json()).error.code).toBe(
		"PAIRING_CODE_INVALID",
	);
}

async function runnerRow(id: string) {
	const row = await scoped(alice.me.tenant.id).first(
		runners,
		eq(runners.id, id),
	);
	if (!row) throw new Error("runner 不存在");
	return row;
}

describe("配对", () => {
	it("配对码为 6 组 4 位，库里只存哈希；正确的码换到 runnerId 与 token", async () => {
		const code = await newCode(alice.client);
		expect(code).toMatch(PAIRING_CODE_RE);
		const stored = await scoped(alice.me.tenant.id).select(
			pairingCodes,
			eq(pairingCodes.ownerId, alice.me.principal.id),
		);
		expect(stored.map((r) => r.codeHash)).toContain(hashSecret(code));
		expect(JSON.stringify(stored)).not.toContain(code);

		const res = await pair(code.toLowerCase().replaceAll("-", " "));
		expect(res.status).toBe(201);
		const { runnerId, token } = PairRunnerResponseSchema.parse(
			await res.json(),
		);
		const row = await runnerRow(runnerId);
		expect(row.tokenHash).toBe(hashSecret(token));
		expect(JSON.stringify(row)).not.toContain(token);
		expect(row).toMatchObject({
			ownerId: alice.me.principal.id,
			name: "测试机",
			status: "offline",
		});
	});

	it("已用过的码 → 400 PAIRING_CODE_INVALID", async () => {
		const code = await newCode(alice.client);
		expect((await pair(code)).status).toBe(201);
		await expectInvalid(await pair(code));
	});

	it("过期的码、格式不对的码 → 400 PAIRING_CODE_INVALID", async () => {
		const s = scoped(alice.me.tenant.id);
		const { code } = await createPairingCode(
			s,
			alice.me.principal.id,
			new Date(Date.now() - 11 * 60 * 1000),
		);
		await expectInvalid(await pair(code));
		await expectInvalid(await pair("AAAA-BBBB"));
		await expectInvalid(await pair("2222-2222-2222-2222-2222-2222"));
	});

	it("并发核销同一个码只有一个成功", async () => {
		const code = await newCode(alice.client);
		const results = await Promise.all([pair(code), pair(code), pair(code)]);
		expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400]);
	});

	it("配对请求带来源：存进库，设备列表按来源返回；不带来源的设备列表里没有 via；不认识的来源 → 400", async () => {
		const desktop = PairRunnerResponseSchema.parse(
			await (
				await pair(await newCode(dave.client), "Dave 的 Mac", "desktop")
			).json(),
		);
		const cli = PairRunnerResponseSchema.parse(
			await (await pair(await newCode(dave.client), "机房", "cli")).json(),
		);
		const legacy = PairRunnerResponseSchema.parse(
			await (await pair(await newCode(dave.client), "旧设备")).json(),
		);
		const res = await dave.client.request("GET", "/api/runners");
		const { items } = RunnerListResponseSchema.parse(await res.json());
		const byId = new Map(items.map((r) => [r.id, r]));
		expect(byId.get(desktop.runnerId)?.via).toBe("desktop");
		expect(byId.get(cli.runnerId)?.via).toBe("cli");
		expect(byId.get(legacy.runnerId)).not.toHaveProperty("via");
		const bad = await anonymous.request("POST", "/api/runners/pair", {
			code: await newCode(dave.client),
			name: "x",
			os: "macOS arm64",
			via: "web",
		});
		expect(bad.status).toBe(400);
		for (const id of [desktop.runnerId, cli.runnerId, legacy.runnerId])
			expect(
				(await dave.client.request("DELETE", `/api/runners/${id}`)).status,
			).toBe(204);
	});

	it("生成配对码需要登录", async () => {
		const res = await anonymous.request("POST", "/api/runners/pairing-codes");
		expect(res.status).toBe(401);
	});
});

describe("我的设备与绑定", () => {
	let mine: { runnerId: string; token: string };
	let bobs: { runnerId: string; token: string };
	let ops: string;
	let twin: string;

	beforeAll(async () => {
		mine = await pairNew(alice.client, "Alice 的 Mac");
		bobs = await pairNew(bob.client, "Bob 的 Mac");
		ops =
			alice.me.agents.find((a) => a.role === "specialist")?.principal.id ?? "";
		twin = alice.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
	});

	it("GET /api/runners 只列出本人的设备", async () => {
		const res = await alice.client.request("GET", "/api/runners");
		const { items } = RunnerListResponseSchema.parse(await res.json());
		expect(items.map((r) => r.id)).toContain(mine.runnerId);
		expect(items.map((r) => r.id)).not.toContain(bobs.runnerId);
		const other = RunnerListResponseSchema.parse(
			await (await dave.client.request("GET", "/api/runners")).json(),
		);
		expect(other.items).toEqual([]);
	});

	it("助手可以绑本人的设备、再解绑", async () => {
		const bound = await alice.client.request("PATCH", `/api/agents/${ops}`, {
			runnerId: mine.runnerId,
		});
		expect(bound.status).toBe(200);
		const { agent }: AgentResponse = AgentResponseSchema.parse(
			await bound.json(),
		);
		expect(agent.runnerId).toBe(mine.runnerId);
		const unbound = await alice.client.request("PATCH", `/api/agents/${ops}`, {
			runnerId: null,
		});
		expect(AgentResponseSchema.parse(await unbound.json()).agent.runnerId).toBe(
			null,
		);
	});

	it("只能绑本人的设备：别人的 / 不存在的 → 404；分身不能绑 → 400", async () => {
		for (const runnerId of [bobs.runnerId, crypto.randomUUID()]) {
			const res = await alice.client.request("PATCH", `/api/agents/${ops}`, {
				runnerId,
			});
			expect(res.status).toBe(404);
		}
		const toTwin = await alice.client.request("PATCH", `/api/agents/${twin}`, {
			runnerId: mine.runnerId,
		});
		expect(toTwin.status).toBe(400);
	});

	it("别人与别的租户吊销不了我的设备（404）", async () => {
		for (const c of [bob.client, dave.client]) {
			const res = await c.request("DELETE", `/api/runners/${mine.runnerId}`);
			expect(res.status).toBe(404);
		}
	});
});

describe("连接与吊销", () => {
	it("hello 后在线并推 runner 帧给主人；断开后离线", async () => {
		const { runnerId } = await pairNew(alice.client);
		const frames = captureFrames(alice.me.principal.id);
		try {
			const conn = connectRunner(await runnerRow(runnerId));
			await conn.up(HELLO);
			expect(runnerHub.isOnline(runnerId)).toBe(true);
			const online = await runnerRow(runnerId);
			expect(online).toMatchObject({ status: "online", workspace: "/tmp/ws" });
			expect(online.capabilities).toEqual(deviceCapabilityList());
			await conn.up({ t: "ping" });
			expect(conn.down).toEqual([{ t: "pong" }]);
			await conn.close();
			expect(runnerHub.isOnline(runnerId)).toBe(false);
			expect((await runnerRow(runnerId)).status).toBe("offline");
			const statuses = frames.frames.flatMap((f) =>
				f.t === "runner" && f.runner.id === runnerId ? [f.runner.status] : [],
			);
			expect(statuses).toEqual(["online", "offline"]);
		} finally {
			frames.stop();
		}
	});

	it("吊销：在线连接以 4003 关闭，token 立即失效（之后连接 401），绑定的代理解绑", async () => {
		const { runnerId, token } = await pairNew(alice.client);
		const ops =
			alice.me.agents.find((a) => a.role === "specialist")?.principal.id ?? "";
		await alice.client.request("PATCH", `/api/agents/${ops}`, { runnerId });
		const row = await authenticateRunner(token);
		expect(row?.id).toBe(runnerId);
		const conn = connectRunner(row ?? (await runnerRow(runnerId)));
		await conn.up(HELLO);

		const res = await alice.client.request(
			"DELETE",
			`/api/runners/${runnerId}`,
		);
		expect(res.status).toBe(204);
		expect(conn.closed?.code).toBe(RUNNER_WS_CLOSE.REVOKED);
		expect(runnerHub.isOnline(runnerId)).toBe(false);
		expect(await authenticateRunner(token)).toBeNull();
		const ws = await anonymous.request(
			"GET",
			`/runner/ws?token=${encodeURIComponent(token)}`,
		);
		expect(ws.status).toBe(401);
		const agent = await alice.client.request("GET", "/api/agents");
		expect(await agent.text()).not.toContain(runnerId);
		const list = RunnerListResponseSchema.parse(
			await (await alice.client.request("GET", "/api/runners")).json(),
		);
		expect(list.items.map((r) => r.id)).not.toContain(runnerId);
		await conn.close();
	});

	it("无效 token → 401，不升级", async () => {
		for (const q of ["", "?token=nope"]) {
			const res = await anonymous.request("GET", `/runner/ws${q}`);
			expect(res.status).toBe(401);
		}
	});
});

describe("RunnerHub", () => {
	function fakeSock(): RunnerSocket & {
		sent: RunnerDown[];
		closed: number | null;
	} {
		const sock = {
			sent: [] as RunnerDown[],
			closed: null as number | null,
			send(data: string) {
				sock.sent.push(JSON.parse(data) as RunnerDown);
			},
			close(code?: number) {
				sock.closed = code ?? null;
			},
		};
		return sock;
	}

	function invokes(sock: { sent: RunnerDown[] }) {
		return sock.sent.flatMap((f) => (f.t === "invoke" ? [f] : []));
	}

	it("设备不在线：立即失败为“设备离线”", async () => {
		const hub = new RunnerHub();
		expect(await hub.invoke("r1", "fs.list", { path: "." })).toEqual({
			ok: false,
			output: OFFLINE_TEXT,
		});
	});

	it("多个 job 并行，按 jobId 交回；别的设备交回的结果不算数", async () => {
		const hub = new RunnerHub();
		const sock = fakeSock();
		hub.attach("r1", sock);
		const a = hub.invoke("r1", "fs.read", { path: "a" });
		const b = hub.invoke("r1", "fs.read", { path: "b" });
		const [ja, jb] = invokes(sock);
		expect(ja?.jobId).not.toBe(jb?.jobId);
		hub.onFrame("r2", sock, {
			t: "result",
			jobId: jb?.jobId ?? "",
			ok: true,
			output: "伪造",
		});
		hub.onFrame("r1", sock, {
			t: "result",
			jobId: jb?.jobId ?? "",
			ok: true,
			output: "B",
		});
		hub.onFrame("r1", sock, {
			t: "result",
			jobId: ja?.jobId ?? "",
			ok: false,
			output: "A",
			exitCode: 2,
		});
		expect(await b).toEqual({ ok: true, output: "B" });
		expect(await a).toEqual({ ok: false, output: "A", exitCode: 2 });
		expect(hub.pendingJobs()).toBe(0);
	});

	it("60s 内没有结果即失败；断线不立即判失败，重连后仍可交回", async () => {
		vi.useFakeTimers();
		try {
			const hub = new RunnerHub();
			const first = fakeSock();
			hub.attach("r1", first);
			const late = hub.invoke("r1", "shell.exec", { command: "sleep 99" });
			const kept = hub.invoke("r1", "shell.exec", { command: "echo" });
			const [, jKept] = invokes(first);
			expect(hub.detach("r1", first)).toBe(true);
			const second = fakeSock();
			hub.attach("r1", second);
			hub.onFrame("r1", second, {
				t: "result",
				jobId: jKept?.jobId ?? "",
				ok: true,
				output: "ok",
			});
			expect(await kept).toEqual({ ok: true, output: "ok" });
			vi.advanceTimersByTime(59_999);
			expect(hub.pendingJobs()).toBe(1);
			vi.advanceTimersByTime(1);
			expect(await late).toEqual({
				ok: false,
				output: "设备在 60 秒内没有返回结果",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("新连接顶掉旧连接（4001）；旧连接的断开不算下线", () => {
		const hub = new RunnerHub();
		const a = fakeSock();
		const b = fakeSock();
		hub.attach("r1", a);
		hub.attach("r1", b);
		expect(a.closed).toBe(RUNNER_WS_CLOSE.REPLACED);
		expect(hub.detach("r1", a)).toBe(false);
		expect(hub.isOnline("r1")).toBe(true);
		expect(hub.detach("r1", b)).toBe(true);
		expect(hub.isOnline("r1")).toBe(false);
	});

	it("中止信号：等待中的 job 以失败返回", async () => {
		const hub = new RunnerHub();
		hub.attach("r1", fakeSock());
		const ctrl = new AbortController();
		const p = hub.invoke("r1", "fs.list", { path: "." }, ctrl.signal);
		ctrl.abort();
		expect((await p).ok).toBe(false);
		expect(hub.pendingJobs()).toBe(0);
	});

	it("结果输出超过 64KB 在服务端同样截断", async () => {
		const hub = new RunnerHub();
		const sock = fakeSock();
		hub.attach("r1", sock);
		const p = hub.invoke("r1", "fs.read", { path: "big" });
		const [job] = invokes(sock);
		hub.onFrame("r1", sock, {
			t: "result",
			jobId: job?.jobId ?? "",
			ok: true,
			output: "x".repeat(100_000),
		});
		const r = await p;
		expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(64 * 1024);
		expect(r.output).toContain("已截断");
	});
});
