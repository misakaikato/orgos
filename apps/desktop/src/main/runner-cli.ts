/**
 * 驱动 Runner 命令行所需的约定：二进制位置、命令参数、配对文件位置、子进程环境。
 * app 只经 `pair` 与 `serve` 两条命令使用 Runner；配对信息只在 Runner 的 runner.json，
 * app 只判断它是否存在、解除配对时删除它，并经 `@orgos/runner/config` 读取其中的 server 与
 * runnerId（从不读取 token）。
 */
import { existsSync, rmSync } from "node:fs";
import { DEVICE_NAME_MAX_LENGTH } from "@orgos/protocol";
import { configPathFor, type PairingIdentity } from "@orgos/runner/config";
import { parseLogLine } from "@/main/runner-log";
import type { Settings } from "@/main/settings";
import type { RunnerIdentity } from "@/shared/ipc";

export function runnerConfigFile(env: NodeJS.ProcessEnv, home: string): string {
	return configPathFor(env, home);
}

export function isPaired(env: NodeJS.ProcessEnv, home: string): boolean {
	return existsSync(runnerConfigFile(env, home));
}

/** 交给聊天页面的本机 Runner 身份。 */
export function runnerIdentityOf(
	settings: Pick<Settings, "runAsRunner">,
	pairing: PairingIdentity | null,
): RunnerIdentity {
	return {
		enabled: settings.runAsRunner,
		paired: pairing !== null,
		server: pairing?.server ?? null,
		runnerId: pairing?.runnerId ?? null,
	};
}

/**
 * app 启动时是否立即启动 Runner：开启了"本机作为 Runner"，且本机已配对到当前设置的服务器
 * （不等聊天窗口登录）。
 */
export function shouldStartOnLaunch(
	settings: Pick<Settings, "runAsRunner" | "serverUrl">,
	pairing: PairingIdentity | null,
): boolean {
	return (
		settings.runAsRunner &&
		settings.serverUrl !== null &&
		pairing?.server === settings.serverUrl
	);
}

/** 运行一条命令，返回标准输出；失败返回 null。 */
export type RunCommand = (file: string, args: string[]) => string | null;

/**
 * 配对时的设备名：macOS 上取系统的"电脑名称"（`scutil --get ComputerName`，例如
 * "misaka 的 MacBook Pro"）；取不到或其他平台用本机名（去掉 .local）。不超过设备名的长度上限。
 */
export function deviceNameOf(
	platform: NodeJS.Platform,
	host: string,
	run: RunCommand,
): string {
	const computerName =
		platform === "darwin"
			? run("/usr/sbin/scutil", ["--get", "ComputerName"])?.trim()
			: undefined;
	const name = computerName || host.replace(/\.local$/, "");
	return name.slice(0, DEVICE_NAME_MAX_LENGTH);
}

export function removePairing(env: NodeJS.ProcessEnv, home: string): void {
	rmSync(runnerConfigFile(env, home), { force: true });
}

export function runnerBinaryName(platform: NodeJS.Platform): string {
	return platform === "win32" ? "orgos-runner.exe" : "orgos-runner";
}

/** 桌面客户端发起的配对一律标记来源为 desktop。 */
export function pairArgs(code: string, server: string, name: string): string[] {
	return [
		"pair",
		code.trim(),
		"--server",
		server,
		"--name",
		name.trim(),
		"--via",
		"desktop",
	];
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
