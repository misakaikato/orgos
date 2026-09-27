/**
 * 开发启动：同时起服务端（8930，浏览器唯一入口）与内部 Next（3930）。
 * 任一进程退出即结束另一个；Ctrl+C 一并停止。
 *
 * 运行：bun run dev（已带 ORGOS_DEV=1 与 NO_PROXY，模拟台在 /sim）。
 * 模型：环境里有 DEEPSEEK_API_KEY 就用真实模型；没有时从 ~/.pi/agent/auth.json 只取
 * `deepseek.key` 这一个字段注入子进程环境（不打印、不写文件、不碰其他字段——该文件里还有别的令牌）；
 * 仍没有则 MOCK_LLM=1。
 */
import { homedir } from "node:os";
import { join } from "node:path";

async function deepseekKeyFromPi(): Promise<string | null> {
	const file = Bun.file(join(homedir(), ".pi", "agent", "auth.json"));
	if (!(await file.exists())) return null;
	try {
		const parsed: unknown = JSON.parse(await file.text());
		const deepseek =
			parsed && typeof parsed === "object"
				? (parsed as Record<string, unknown>).deepseek
				: undefined;
		const key =
			deepseek && typeof deepseek === "object"
				? (deepseek as Record<string, unknown>).key
				: undefined;
		return typeof key === "string" && key.trim() ? key.trim() : null;
	} catch {
		return null;
	}
}

const deepseekKey =
	process.env.DEEPSEEK_API_KEY || (await deepseekKeyFromPi()) || null;

const env: Record<string, string | undefined> = {
	...process.env,
	ORGOS_DEV: "1",
	NO_PROXY: "localhost,127.0.0.1",
	no_proxy: "localhost,127.0.0.1",
	...(deepseekKey ? { DEEPSEEK_API_KEY: deepseekKey } : { MOCK_LLM: "1" }),
};

console.log(
	env.MOCK_LLM === "1"
		? "[dev] 假模型（MOCK_LLM=1）"
		: process.env.DEEPSEEK_API_KEY
			? "[dev] 真实模型（DEEPSEEK_API_KEY 来自环境）"
			: "[dev] 真实模型（DEEPSEEK_API_KEY 来自 ~/.pi/agent/auth.json）",
);

const root = new URL("../", import.meta.url).pathname;

const children = [
	Bun.spawn(["bun", "run", "--cwd", "apps/server", "dev"], {
		cwd: root,
		env,
		stdio: ["inherit", "inherit", "inherit"],
	}),
	Bun.spawn(["bun", "run", "--cwd", "apps/web", "dev"], {
		cwd: root,
		env,
		stdio: ["inherit", "inherit", "inherit"],
	}),
];

let stopping = false;
function stopAll(code: number): void {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill("SIGTERM");
	void Promise.all(children.map((c) => c.exited)).then(() =>
		process.exit(code),
	);
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
for (const child of children) {
	void child.exited.then((code) => stopAll(code ?? 1));
}
