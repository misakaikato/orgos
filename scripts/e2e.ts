/**
 * 端到端验收：在无网络的假模型下证明整个 MVP 可用。
 *
 * 运行：MOCK_LLM=1 bun scripts/e2e.ts（或 bun run e2e）。
 * 自建库 orgos_e2e 并迁移，以子进程起服务端于 8931（不起 Next），自建两个租户：
 * "测试公司"（alice 为 owner，bob、carol）与"别家公司"（dave）；Runner 用临时的
 * ORGOS_RUNNER_HOME 与工作目录。结束时（无论成败）停进程、删临时目录、删库。
 *
 * 每个场景逐项打印"✓ 场景 · 子项"；任一项失败打印期望与实际并以 1 退出。
 * 场景清单即系统的承诺，顺序有依赖（后面的场景沿用前面建立的会话与设备）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createDatabase,
	dropDatabase,
	exited,
	openSql,
	person,
	type ServerProcess,
	type Sql,
	startServer,
} from "@tests/process-harness";
import { device, external, isolation, revoke } from "./e2e/devices";
import {
	Mismatch,
	member,
	type Scenario,
	type Step,
	type World,
} from "./e2e/kit";
import { antiLoop, c1, c2, groupRounds } from "./e2e/messaging";
import { appApi, org } from "./e2e/org-api";
import { memory, topics } from "./e2e/topics-memory";
import { c3, c4 } from "./e2e/twin";

const PORT = 8931;
const DATABASE_URL = "postgresql://orgos:orgos@127.0.0.1:5470/orgos_e2e";
const PASSWORD = "orgos-e2e-pass";

const SCENARIOS: Scenario[] = [
	c2,
	c1,
	groupRounds,
	c3,
	c4,
	antiLoop,
	topics,
	memory,
	appApi,
	org,
	device,
	external,
	isolation,
	revoke,
];

if (process.env.MOCK_LLM !== "1") {
	console.error("e2e 只在假模型下运行：MOCK_LLM=1 bun scripts/e2e.ts");
	process.exit(2);
}

async function world(base: string, sql: Sql, tmp: string): Promise<World> {
	const join = async (name: string, handle: string, inviteCode?: string) => {
		const p = await person(base, {
			name,
			handle,
			email: `${handle}@e2e.orgos.test`,
			password: PASSWORD,
			inviteCode,
			orgName: inviteCode
				? undefined
				: name === "Dave"
					? "别家公司"
					: "测试公司",
		});
		return member(name, p);
	};
	const alice = await join("Alice", "alice");
	const invite = alice.me.tenant.inviteCode;
	const runnerHome = path.join(tmp, "home");
	const workspace = path.join(tmp, "workspace");
	await mkdir(path.join(workspace, "proj"), { recursive: true });
	await writeFile(path.join(workspace, "readme.md"), "# e2e 工作目录\n");
	await writeFile(
		path.join(workspace, "proj", "calc.py"),
		"def add(a, b):\n\treturn a + b\n",
	);
	return {
		base,
		sql,
		alice,
		bob: await join("Bob", "bob", invite),
		carol: await join("Carol", "carol", invite),
		dave: await join("Dave", "dave"),
		runnerHome,
		workspace,
		ids: { pairDm: "", aliceTwinDm: "", decisionItem: "" },
		device: { runnerId: "", token: "", child: null, log: "" },
	};
}

function show(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** 已由子项打印过的失败，入口不再重复打印。 */
const reported = new WeakSet<object>();

function stepper(scenario: string, counts: { items: number }): Step {
	return async (item, fn) => {
		try {
			await fn();
		} catch (e) {
			if (e instanceof Object) reported.add(e);
			console.error(`✗ ${scenario} · ${item}`);
			if (e instanceof Mismatch) {
				console.error(`  断言：${e.message}`);
				console.error(`  期望：${show(e.expected)}`);
				console.error(`  实际：${show(e.actual)}`);
			} else console.error(e);
			throw e;
		}
		counts.items += 1;
		console.log(`✓ ${scenario} · ${item}`);
	};
}

async function main(): Promise<number> {
	const started = Date.now();
	const tmp = await mkdtemp(path.join(tmpdir(), "orgos-e2e-"));
	let server: ServerProcess | null = null;
	let sql: Sql | null = null;
	let w: World | null = null;
	const counts = { items: 0 };
	try {
		await createDatabase(DATABASE_URL);
		server = await startServer({
			port: PORT,
			databaseUrl: DATABASE_URL,
			env: { MOCK_LLM: "1", ORGOS_DEV: "1", DEEPSEEK_API_KEY: undefined },
		});
		sql = openSql(DATABASE_URL);
		w = await world(server.base, sql, tmp);
		for (const s of SCENARIOS) await s.run(w, stepper(s.name, counts));
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(
			`\n通过：${SCENARIOS.length} 个场景、${counts.items} 个子项，用时 ${seconds} 秒`,
		);
		return 0;
	} catch (e) {
		if (!(e instanceof Object && reported.has(e))) console.error(e);
		if (server)
			console.error(`\n服务端日志（末尾）：\n${server.log().slice(-4000)}`);
		if (w?.device.log)
			console.error(`\nRunner 日志（末尾）：\n${w.device.log.slice(-2000)}`);
		return 1;
	} finally {
		const child = w?.device.child;
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			await exited(child);
		}
		await server?.stop();
		await sql?.end();
		await dropDatabase(DATABASE_URL);
		await rm(tmp, { recursive: true, force: true });
	}
}

process.exit(await main());
