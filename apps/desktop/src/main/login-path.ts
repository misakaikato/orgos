/**
 * 登录 shell 的 PATH。从 Dock 或开机自启拉起的 app 只拿到 launchd 的精简 PATH，
 * Runner 会因此找不到 `claude`、`codex`、`npx`。启动时用登录交互 shell 解析一次，交给子进程。
 */
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/** 包住 PATH 的标记：shell 的启动脚本可能往输出里打印别的内容。 */
export const PATH_MARK = "__ORGOS_LOGIN_PATH__";

/** 在登录 shell 里打印 PATH 的命令（`-i -l`：读 .zprofile 与 .zshrc 这类启动脚本）。 */
export function loginShellCommand(shell: string): {
	command: string;
	args: string[];
} {
	return {
		command: shell,
		args: ["-ilc", `printf '%s%s%s' '${PATH_MARK}' "$PATH" '${PATH_MARK}'`],
	};
}

/** 从 shell 输出里取出标记之间的 PATH；取不到返回 null。 */
export function parseLoginPath(stdout: string): string | null {
	const start = stdout.indexOf(PATH_MARK);
	if (start < 0) return null;
	const from = start + PATH_MARK.length;
	const end = stdout.indexOf(PATH_MARK, from);
	if (end < 0) return null;
	const value = stdout.slice(from, end).trim();
	return value ? value : null;
}

/** 合并若干 PATH：保持先后顺序、去掉重复与空段。 */
export function mergePaths(...lists: Array<string | null | undefined>): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of lists) {
		for (const dir of (list ?? "").split(path.delimiter)) {
			if (!dir || seen.has(dir)) continue;
			seen.add(dir);
			out.push(dir);
		}
	}
	return out.join(path.delimiter);
}

export type ShellRunner = (
	command: string,
	args: string[],
	timeoutMs: number,
) => Promise<string>;

/**
 * 解析登录 PATH：登录 shell 给出的在前，本进程已有的在后。
 * shell 失败或超时时只用本进程的 PATH，并返回失败原因。
 */
export async function resolveLoginPath(opts: {
	shell: string;
	currentPath: string | undefined;
	run: ShellRunner;
	timeoutMs?: number;
}): Promise<{ path: string; error: string | null }> {
	const { command, args } = loginShellCommand(opts.shell);
	try {
		const out = await opts.run(command, args, opts.timeoutMs ?? 10_000);
		const login = parseLoginPath(out);
		if (!login)
			return {
				path: mergePaths(opts.currentPath),
				error: "登录 shell 的输出里没有 PATH",
			};
		return { path: mergePaths(login, opts.currentPath), error: null };
	} catch (e) {
		return {
			path: mergePaths(opts.currentPath),
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

function isExecutableFile(file: string): boolean {
	try {
		if (!statSync(file).isFile()) return false;
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** 在给定 PATH 上找可执行文件（Windows 依次试 PATHEXT 的扩展名）。 */
export function findExecutable(
	bin: string,
	searchPath: string,
	isExecutable: (file: string) => boolean = isExecutableFile,
	exts: readonly string[] = process.platform === "win32"
		? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
		: [""],
): string | null {
	for (const dir of searchPath.split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const file = path.join(dir, bin + ext);
			if (isExecutable(file)) return file;
		}
	}
	return null;
}
