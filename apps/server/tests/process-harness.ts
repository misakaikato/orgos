/**
 * 以子进程真实启动服务端与 Runner 命令行时共用的动作，不依赖 vitest：
 * 独立库的建立、迁移与删除，服务端子进程，HTTP 客户端，注册并入驻，轮询等待，Runner 命令行，WS 握手状态。
 * 使用者：tests/runner-e2e、tests/acp-e2e、tests/global-setup，以及 scripts/e2e.ts、scripts/smoke-llm.ts。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type MeResponse, MeResponseSchema } from "@orgos/protocol";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const NO_PROXY = "localhost,127.0.0.1";
export const SERVER_DIR = fileURLToPath(new URL("../", import.meta.url));
export const RUNNER_DIR = path.resolve(SERVER_DIR, "../runner");
const MIGRATIONS_DIR = path.join(SERVER_DIR, "drizzle");
export const DEFAULT_PASSWORD = "test-password-123";

// ─────────────────────────── 数据库 ───────────────────────────

/** 同一 Postgres 实例上的维护库（建库、删库用）。 */
function maintenanceUrl(databaseUrl: string): string {
	const url = new URL(databaseUrl);
	url.pathname = "/postgres";
	return url.toString();
}

function databaseName(databaseUrl: string): string {
	return new URL(databaseUrl).pathname.slice(1);
}

export type Sql = postgres.Sql;

/** 直连某个库（脚本做断言与快进时钟用）。 */
export function openSql(databaseUrl: string): Sql {
	return postgres(databaseUrl, { max: 2, onnotice: () => {} });
}

/** 清空库里的全部表并应用全部迁移。 */
export async function resetDatabase(databaseUrl: string): Promise<void> {
	const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
	try {
		await sql`drop schema if exists drizzle cascade`;
		await sql`drop schema public cascade`;
		await sql`create schema public`;
		await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
	} finally {
		await sql.end();
	}
}

/** 删库（断开其上的连接）；库不存在时什么都不做。 */
export async function dropDatabase(databaseUrl: string): Promise<void> {
	const sql = postgres(maintenanceUrl(databaseUrl), {
		max: 1,
		onnotice: () => {},
	});
	try {
		await sql`drop database if exists ${sql(databaseName(databaseUrl))} with (force)`;
	} finally {
		await sql.end();
	}
}

/** 新建一个空库（已有同名库先删）并应用全部迁移。 */
export async function createDatabase(databaseUrl: string): Promise<void> {
	await dropDatabase(databaseUrl);
	const sql = postgres(maintenanceUrl(databaseUrl), {
		max: 1,
		onnotice: () => {},
	});
	try {
		await sql`create database ${sql(databaseName(databaseUrl))}`;
	} finally {
		await sql.end();
	}
	await resetDatabase(databaseUrl);
}

// ─────────────────────────── 进程 ───────────────────────────

export function exited(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null) return Promise.resolve(child.exitCode);
	return new Promise((r) => child.once("exit", (code) => r(code)));
}

/** 轮询直到 fn 给出真值；超时抛错并写明在等什么。 */
export async function until<T>(
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

export type ServerProcess = {
	base: string;
	child: ChildProcess;
	/** 服务端至今的 stdout 与 stderr。 */
	log(): string;
	stop(): Promise<void>;
};

/** 以子进程启动服务端（`bun src/serve.ts`），等到 /healthz 可用。 */
export async function startServer(opts: {
	port: number;
	databaseUrl: string;
	env?: Record<string, string | undefined>;
}): Promise<ServerProcess> {
	const base = `http://localhost:${opts.port}`;
	let log = "";
	// opts.env 里值为 undefined 的键表示从继承的环境里去掉。
	const env = Object.fromEntries(
		Object.entries({
			...process.env,
			PORT: String(opts.port),
			DATABASE_URL: opts.databaseUrl,
			BETTER_AUTH_URL: base,
			NO_PROXY,
			no_proxy: NO_PROXY,
			...opts.env,
		}).filter((kv): kv is [string, string] => kv[1] !== undefined),
	);
	const child = spawn("bun", ["src/serve.ts"], {
		cwd: SERVER_DIR,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const append = (d: Buffer) => {
		log += d.toString();
	};
	child.stdout?.on("data", append);
	child.stderr?.on("data", append);
	const server: ServerProcess = {
		base,
		child,
		log: () => log,
		stop: async () => {
			if (child.exitCode !== null) return;
			child.kill("SIGTERM");
			await exited(child);
		},
	};
	try {
		await until(
			"服务端启动",
			async () => {
				if (child.exitCode !== null)
					throw new Error(`服务端已退出（${child.exitCode}）：${log}`);
				return (await fetch(`${base}/healthz`)).ok;
			},
			30_000,
		);
	} catch (e) {
		await server.stop();
		throw new Error(`${e instanceof Error ? e.message : e}\n${log}`);
	}
	return server;
}

/** 以子进程运行 Runner 命令行（pair / serve）。 */
export function runCli(
	home: string,
	args: string[],
	env: Record<string, string> = {},
): ChildProcess {
	return spawn("bun", ["run", "src/main.ts", ...args], {
		cwd: RUNNER_DIR,
		env: {
			...process.env,
			ORGOS_RUNNER_HOME: home,
			NO_PROXY,
			no_proxy: NO_PROXY,
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** 发一次 WS 升级握手，返回 HTTP 状态码（101 表示升级成功）。 */
export function wsHandshakeStatus(base: string, p: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(`${base}${p}`, {
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

// ─────────────────────────── HTTP ───────────────────────────

export type Http = {
	base: string;
	/** 登录后的 Cookie 头（未登录为空串），供 WS 等非 REST 场景复用。 */
	cookie: string;
	request(method: string, p: string, body?: unknown): Promise<Response>;
};

export function http(base: string, cookie = ""): Http {
	return {
		base,
		cookie,
		request: (method, p, body) =>
			fetch(`${base}${p}`, {
				method,
				headers: {
					"content-type": "application/json",
					origin: base,
					...(cookie ? { cookie } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
	};
}

export type Person = {
	client: Http;
	me: MeResponse;
	email: string;
	/** better-auth 会话 token（bearer 插件签发），可作 `Authorization: Bearer` 或 `/ws?token=`。 */
	token: string;
};

const suffix = () =>
	`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * 注册、登录并入驻：给了邀请码就加入该租户，否则新建组织。
 * handle 与邮箱缺省时按名字加随机后缀生成。
 */
export async function person(
	base: string,
	opts: {
		name: string;
		handle?: string;
		email?: string;
		inviteCode?: string;
		orgName?: string;
		password?: string;
	},
): Promise<Person> {
	const tag = opts.name.toLowerCase().replace(/[^a-z]/g, "") || "p";
	const handle = opts.handle ?? `${tag}${suffix()}`;
	const email = opts.email ?? `${handle}@orgos.test`;
	const password = opts.password ?? DEFAULT_PASSWORD;
	const anon = http(base);
	const up = await anon.request("POST", "/api/auth/sign-up/email", {
		email,
		password,
		name: opts.name,
	});
	if (up.status !== 200)
		throw new Error(`注册 ${email} → ${up.status}：${await up.text()}`);
	const res = await anon.request("POST", "/api/auth/sign-in/email", {
		email,
		password,
	});
	if (res.status !== 200)
		throw new Error(`登录 ${email} → ${res.status}：${await res.text()}`);
	const cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
	const token = res.headers.get("set-auth-token") ?? "";
	const client = http(base, cookie);
	const onboard = await client.request(
		"POST",
		"/api/onboarding",
		opts.inviteCode
			? {
					mode: "join",
					inviteCode: opts.inviteCode,
					displayName: opts.name,
					handle,
				}
			: {
					mode: "create",
					orgName: opts.orgName ?? `org-${handle}`,
					displayName: opts.name,
					handle,
				},
	);
	if (onboard.status !== 201)
		throw new Error(
			`入驻 ${handle} → ${onboard.status}：${await onboard.text()}`,
		);
	const me = MeResponseSchema.parse(
		await (await client.request("GET", "/api/me")).json(),
	);
	return { client, me, email, token };
}
