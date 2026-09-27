/**
 * 构建桌面端：
 *   dist/app/     主进程、两个 preload、本地页面（样式直接引用 apps/web 的 tokens.css）
 *   dist/runner/  `bun build --compile` 编出的 Runner 单文件可执行程序（打包时放进 resources）
 */
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const APP = path.join(ROOT, "dist", "app");
const RUNNER_OUT = path.join(ROOT, "dist", "runner");
const RUNNER_DIR = path.resolve(ROOT, "../runner");
const TOKENS = path.resolve(ROOT, "../web/src/app/tokens.css");
const RUNNER_NAME =
	process.platform === "win32" ? "orgos-runner.exe" : "orgos-runner";

async function bundle(
	entry: string,
	name: string,
	target: "node" | "browser",
	format: "cjs" | "iife",
): Promise<void> {
	const r = await Bun.build({
		entrypoints: [path.join(ROOT, entry)],
		outdir: APP,
		naming: name,
		target,
		format,
		external: ["electron"],
		sourcemap: "none",
	});
	if (!r.success) {
		for (const log of r.logs) console.error(log);
		throw new Error(`打包失败：${entry}`);
	}
}

async function compileRunner(): Promise<void> {
	await mkdir(RUNNER_OUT, { recursive: true });
	const proc = Bun.spawnSync(
		[
			process.execPath,
			"build",
			"--compile",
			"src/main.ts",
			"--outfile",
			path.join(RUNNER_OUT, RUNNER_NAME),
		],
		{ cwd: RUNNER_DIR, stdout: "inherit", stderr: "inherit" },
	);
	if (proc.exitCode !== 0) throw new Error("Runner 编译失败");
}

await rm(path.join(ROOT, "dist"), { recursive: true, force: true });
await mkdir(APP, { recursive: true });
await bundle("src/main/index.ts", "main.cjs", "node", "cjs");
await bundle("src/preload/chat.ts", "preload-chat.cjs", "browser", "cjs");
await bundle("src/preload/control.ts", "preload-control.cjs", "browser", "cjs");
await bundle("src/renderer/control.ts", "control.js", "browser", "iife");
await bundle("src/renderer/setup.ts", "setup.js", "browser", "iife");
await bundle("src/renderer/offline.ts", "offline.js", "browser", "iife");
for (const file of ["control.html", "setup.html", "offline.html", "page.css"])
	await cp(path.join(ROOT, "src/renderer", file), path.join(APP, file));
await cp(TOKENS, path.join(APP, "tokens.css"));
await compileRunner();
console.log(
	`已构建：${path.relative(process.cwd(), APP)}、${path.relative(process.cwd(), RUNNER_OUT)}`,
);
