/**
 * 以真实子进程运行 Runner 二进制：看护用的 serve 与一次性的 pair。
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ChildHandle, SpawnHooks } from "@/main/supervisor";

/**
 * app 上次没能正常退出（崩溃、被强杀）时遗留的 Runner 进程：按 pid 文件找到它，
 * 确认命令行确实是这个 Runner 二进制后结束它，免得和新起的 Runner 抢同一个设备连接。
 */
export function killOrphanRunner(
	pidFile: string,
	binary: string,
): number | null {
	let pid: number;
	try {
		pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
	} catch {
		return null;
	}
	rmSync(pidFile, { force: true });
	if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32")
		return null;
	let command: string;
	try {
		command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
			encoding: "utf8",
		}).trim();
	} catch {
		return null;
	}
	if (!command.startsWith(binary)) return null;
	process.kill(pid, "SIGTERM");
	return pid;
}

/** 记下（或清除）当前 Runner 子进程的 pid。 */
export function writeRunnerPid(pidFile: string, pid: number | null): void {
	if (pid === null) rmSync(pidFile, { force: true });
	else writeFileSync(pidFile, `${pid}\n`);
}

export type RunnerCommand = {
	binary: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
};

/** 起一个长期运行的子进程；标准输出与标准错误都交给 onOutput。 */
export function spawnRunner(
	cmd: RunnerCommand,
	hooks: SpawnHooks,
): ChildHandle {
	const child = spawn(cmd.binary, cmd.args, {
		cwd: cmd.cwd,
		env: cmd.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let done = false;
	const finish = (code: number | null, signal: string | null) => {
		if (done) return;
		done = true;
		hooks.onExit(code, signal);
	};
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => hooks.onOutput(chunk));
	child.stderr.on("data", (chunk: string) => hooks.onOutput(chunk));
	child.on("error", (err) => {
		hooks.onOutput(`无法启动 Runner：${err.message}\n`);
		finish(null, null);
	});
	child.on("close", (code, signal) => finish(code, signal));
	return {
		get pid() {
			return child.pid;
		},
		kill: (signal) => {
			if (child.exitCode === null && child.signalCode === null)
				child.kill(signal);
		},
	};
}

/** 跑一次到结束的命令（pair），收集输出。 */
export function runOnce(
	cmd: RunnerCommand,
	timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd.binary, cmd.args, {
			cwd: cmd.cwd,
			env: cmd.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c: string) => {
			stdout += c;
		});
		child.stderr.on("data", (c: string) => {
			stderr += c;
		});
		const timer = setTimeout(() => {
			stderr += `\n${Math.round(timeoutMs / 1000)} 秒内没有完成，已中止`;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({
				code: null,
				stdout,
				stderr: `${stderr}\n无法启动 Runner：${err.message}`,
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

/** 用登录 shell 执行一条命令并返回标准输出（解析登录 PATH 用）。 */
export function runShell(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c: string) => {
			out += c;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(`登录 shell ${Math.round(timeoutMs / 1000)} 秒内没有返回`),
			);
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		// 启动脚本里有报错时 shell 可能以非 0 退出，但 PATH 已经打印出来：以输出为准。
		child.on("close", () => {
			clearTimeout(timer);
			resolve(out);
		});
	});
}
