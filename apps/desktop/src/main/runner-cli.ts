/**
 * 驱动 Runner 命令行所需的约定：二进制位置、命令参数、配对文件位置、子进程环境。
 * app 只经 `pair` 与 `serve` 两条命令使用 Runner；配对信息只在 Runner 的 runner.json，
 * app 只判断它是否存在、解除配对时删除它，从不读取其中内容。
 */
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { parseLogLine } from "@/main/runner-log";

/** 与 apps/runner/src/config.ts 的 runnerHome() 同一规则。 */
export function runnerHome(env: NodeJS.ProcessEnv, home: string): string {
	return env.ORGOS_RUNNER_HOME || path.join(home, ".orgos");
}

export function runnerConfigFile(env: NodeJS.ProcessEnv, home: string): string {
	return path.join(runnerHome(env, home), "runner.json");
}

export function isPaired(env: NodeJS.ProcessEnv, home: string): boolean {
	return existsSync(runnerConfigFile(env, home));
}

export function removePairing(env: NodeJS.ProcessEnv, home: string): void {
	rmSync(runnerConfigFile(env, home), { force: true });
}

export function runnerBinaryName(platform: NodeJS.Platform): string {
	return platform === "win32" ? "orgos-runner.exe" : "orgos-runner";
}

export function pairArgs(code: string, server: string, name: string): string[] {
	return ["pair", code.trim(), "--server", server, "--name", name.trim()];
}

export function serveArgs(
	workspace: string,
	adapters: string | null,
): string[] {
	return [
		"serve",
		"--workspace",
		workspace,
		...(adapters === null ? [] : ["--adapters", adapters]),
	];
}

/** Runner 子进程的环境：登录 PATH，本机请求不走代理。 */
export function runnerEnv(
	base: NodeJS.ProcessEnv,
	loginPath: string,
): NodeJS.ProcessEnv {
	return {
		...base,
		PATH: loginPath,
		NO_PROXY: "localhost,127.0.0.1",
		no_proxy: "localhost,127.0.0.1",
	};
}

/**
 * `pair` 的结果：成功时是它打印到标准输出的一句话；失败时是它最后一行非日志格式的报错
 * （Runner 把异常信息原样写到标准错误后以 1 退出）。
 */
export function pairOutcome(
	code: number | null,
	stdout: string,
	stderr: string,
): { ok: true; message: string } | { ok: false; message: string } {
	if (code === 0) return { ok: true, message: stdout.trim() || "已配对" };
	const lines = stderr
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !parseLogLine(l));
	return {
		ok: false,
		message: lines.at(-1) ?? `配对失败（退出码 ${code ?? "无"}）`,
	};
}
