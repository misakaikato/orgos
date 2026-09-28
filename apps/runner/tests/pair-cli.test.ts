/**
 * `pair` 命令的提示：成功后打印下一步；失败且本机已有 runner.json 时，报错后说明无需重复配对，
 * 且不泄露 token。真起一个本地 HTTP 服务、真跑 CLI 子进程，配对目录用临时的 ORGOS_RUNNER_HOME。
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAIN = path.join(import.meta.dir, "..", "src", "main.ts");
const RUNNER_ID = "5b0e8a44-5d0c-4c62-9d44-1f5b2a7c9e01";
const OLD_TOKEN = "old-token-must-not-leak";
const NEW_TOKEN = "new-token-must-not-leak";
const USED_CODE = "USED-CODE";
const REJECTED = "配对码无效、已过期或已被使用";

let base: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
	base = await mkdtemp(path.join(tmpdir(), "orgos-runner-pair-"));
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const { code } = (await req.json()) as { code: string };
			if (code === USED_CODE)
				return Response.json(
					{ error: { code: "PAIRING_CODE_INVALID", message: REJECTED } },
					{ status: 400 },
				);
			return Response.json(
				{ runnerId: RUNNER_ID, token: NEW_TOKEN },
				{ status: 201 },
			);
		},
	});
});

afterAll(async () => {
	server.stop(true);
	await rm(base, { recursive: true, force: true });
});

async function runPair(home: string, code: string) {
	const proc = Bun.spawn(
		[
			process.execPath,
			MAIN,
			"pair",
			code,
			"--server",
			server.url.origin,
			"--name",
			"测试机",
		],
		{
			env: {
				...process.env,
				ORGOS_RUNNER_HOME: home,
				NO_PROXY: "localhost,127.0.0.1",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("pair 的提示", () => {
	it("成功：写入 runner.json，并打印下一步怎么启动；输出不含 token", async () => {
		const home = path.join(base, "fresh");
		const r = await runPair(home, "GOOD-CODE");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("已配对“测试机”");
		expect(r.stdout).toContain(
			"启动：bun run --cwd apps/runner start serve --workspace <工作目录>，或在桌面客户端里启动",
		);
		expect(`${r.stdout}${r.stderr}`).not.toContain(NEW_TOKEN);
		const saved = JSON.parse(
			await readFile(path.join(home, "runner.json"), "utf8"),
		) as { runnerId: string };
		expect(saved.runnerId).toBe(RUNNER_ID);
	});

	it("已配对的电脑再用用过的配对码：同一行报错后提示已配对的服务器，不含 token", async () => {
		const home = path.join(base, "paired");
		await mkdir(home, { recursive: true });
		await writeFile(
			path.join(home, "runner.json"),
			JSON.stringify({
				server: "http://orgos.example:8930",
				runnerId: RUNNER_ID,
				token: OLD_TOKEN,
			}),
		);
		const r = await runPair(home, USED_CODE);
		expect(r.exitCode).toBe(1);
		const last = r.stderr.trim().split("\n").at(-1) ?? "";
		expect(last).toContain(REJECTED);
		expect(last).toContain(
			"这台电脑已配对（服务器 http://orgos.example:8930），无需重复配对；配对码只能用一次。",
		);
		expect(`${r.stdout}${r.stderr}`).not.toContain(OLD_TOKEN);
	});

	it("没配对过的电脑配对失败：只有原报错，没有已配对的提示", async () => {
		const r = await runPair(path.join(base, "never"), USED_CODE);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain(REJECTED);
		expect(r.stderr).not.toContain("已配对");
	});
});
