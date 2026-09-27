/**
 * 在工作目录里执行四项能力。所有路径都先 resolve 到工作目录内，再用 realpath 校验：
 * `../` 越界、指向工作目录外的绝对路径、经符号链接逃逸，一律拒绝，不读不写。
 *
 * shell.exec 用 `Bun.spawn(['/bin/sh','-c',cmd], { cwd: workspace })`，独立进程组，
 * 超时整组杀掉；stdout 与 stderr 按到达顺序合并，截断到 64KB 并注明。
 */
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
	DEVICE_CAPABILITIES,
	type DeviceCapabilityName,
	RUNNER_JOB_TIMEOUT_MS,
	RUNNER_OUTPUT_MAX_BYTES,
	truncateOutput,
} from "@orgos/protocol";

export type JobOutcome = { ok: boolean; output: string; exitCode?: number };

export class WorkspaceError extends Error {
	override name = "WorkspaceError";
}

function inside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const OUTSIDE = "路径超出工作目录，已拒绝";

/** 工作目录本身（realpath 后）。 */
export async function openWorkspace(dir: string): Promise<string> {
	const abs = path.resolve(dir);
	await mkdir(abs, { recursive: true });
	const real = await realpath(abs);
	const st = await lstat(real);
	if (!st.isDirectory()) throw new WorkspaceError(`${dir} 不是目录`);
	return real;
}

/** 已存在的路径：解析到工作目录内，且真实位置（跟随符号链接后）仍在工作目录内。 */
export async function resolveExisting(
	workspace: string,
	p: string,
): Promise<string> {
	const target = path.resolve(workspace, p || ".");
	if (!inside(workspace, target)) throw new WorkspaceError(OUTSIDE);
	let real: string;
	try {
		real = await realpath(target);
	} catch {
		throw new WorkspaceError(`找不到 ${p}`);
	}
	if (!inside(workspace, real)) throw new WorkspaceError(OUTSIDE);
	return real;
}

/**
 * 要写入的路径：父目录（不存在则在最近的已存在祖先下创建）与目标本身都必须落在工作目录内；
 * 目标若是符号链接，其真实位置也必须在工作目录内（悬空链接拒绝）。
 */
export async function resolveForWrite(
	workspace: string,
	p: string,
): Promise<string> {
	const target = path.resolve(workspace, p);
	if (target === workspace || !inside(workspace, target))
		throw new WorkspaceError(OUTSIDE);
	let ancestor = path.dirname(target);
	while (!(await exists(ancestor))) ancestor = path.dirname(ancestor);
	if (!inside(workspace, await realpath(ancestor)))
		throw new WorkspaceError(OUTSIDE);
	const parent = path.dirname(target);
	await mkdir(parent, { recursive: true });
	const realParent = await realpath(parent);
	if (!inside(workspace, realParent)) throw new WorkspaceError(OUTSIDE);
	const finalPath = path.join(realParent, path.basename(target));
	const st = await lstat(finalPath).catch(() => null);
	if (st?.isSymbolicLink()) {
		const real = await realpath(finalPath).catch(() => null);
		if (!real || !inside(workspace, real)) throw new WorkspaceError(OUTSIDE);
		return real;
	}
	if (st?.isDirectory()) throw new WorkspaceError(`${p} 是目录`);
	return finalPath;
}

async function exists(p: string): Promise<boolean> {
	return (await lstat(p).catch(() => null)) !== null;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function listDir(workspace: string, p: string): Promise<string> {
	const dir = await resolveExisting(workspace, p);
	const entries = await readdir(dir, { withFileTypes: true });
	if (entries.length === 0) return "（空目录）";
	const rows = await Promise.all(
		entries.map(async (e) => {
			if (e.isDirectory()) return { dir: true, line: `${e.name}/` };
			if (e.isSymbolicLink()) return { dir: false, line: `${e.name}@` };
			const st = await lstat(path.join(dir, e.name)).catch(() => null);
			return {
				dir: false,
				line: st ? `${e.name}  ${formatSize(st.size)}` : e.name,
			};
		}),
	);
	rows.sort(
		(a, b) => Number(b.dir) - Number(a.dir) || a.line.localeCompare(b.line),
	);
	return rows.map((r) => r.line).join("\n");
}

async function readText(workspace: string, p: string): Promise<string> {
	const file = await resolveExisting(workspace, p);
	const st = await lstat(file);
	if (st.isDirectory()) throw new WorkspaceError(`${p} 是目录，请用列目录`);
	const buf = await readFile(file);
	if (buf.subarray(0, 8000).includes(0))
		throw new WorkspaceError(`${p} 是二进制文件，不读取`);
	return buf.toString("utf8");
}

async function writeText(
	workspace: string,
	p: string,
	content: string,
): Promise<string> {
	const file = await resolveForWrite(workspace, p);
	await writeFile(file, content, "utf8");
	return `已写入 ${path.relative(workspace, file)}（${Buffer.byteLength(content)} 字节）`;
}

/** 执行一条命令：合并输出、超时整组杀掉。 */
export async function execCommand(
	workspace: string,
	command: string,
	timeoutMs = RUNNER_JOB_TIMEOUT_MS,
): Promise<JobOutcome> {
	const proc = Bun.spawn(["/bin/sh", "-c", command], {
		cwd: workspace,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	const chunks: Uint8Array[] = [];
	let kept = 0;
	/** 只保留够截断用的字节，其余读掉丢弃，避免子进程因管道写满而阻塞。 */
	const keepLimit = RUNNER_OUTPUT_MAX_BYTES + 1;
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (kept < keepLimit) {
				const part = value.subarray(0, keepLimit - kept);
				chunks.push(part);
				kept += part.length;
			}
		}
	};
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}
	}, timeoutMs);
	const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
	const exitCode = await proc.exited;
	clearTimeout(timer);
	// 进程已退出：给管道一点时间收尾；孙进程仍握着管道时不再等。
	await Promise.race([drained, Bun.sleep(200)]);
	const text = Buffer.concat(chunks).toString("utf8");
	if (timedOut) {
		return {
			ok: false,
			output: truncateOutput(
				`${text}${text ? "\n" : ""}命令超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止`,
			),
		};
	}
	return { ok: true, output: truncateOutput(text), exitCode };
}

/** 执行一次 invoke；参数不合法、路径越界等都以失败结果返回，不抛异常。 */
export async function runCapability(
	workspace: string,
	capability: DeviceCapabilityName,
	rawArgs: unknown,
): Promise<JobOutcome> {
	try {
		switch (capability) {
			case "fs.list": {
				const a = DEVICE_CAPABILITIES["fs.list"].args.parse(rawArgs);
				return ok(await listDir(workspace, a.path));
			}
			case "fs.read": {
				const a = DEVICE_CAPABILITIES["fs.read"].args.parse(rawArgs);
				return ok(await readText(workspace, a.path));
			}
			case "fs.write": {
				const a = DEVICE_CAPABILITIES["fs.write"].args.parse(rawArgs);
				return ok(await writeText(workspace, a.path, a.content));
			}
			case "shell.exec": {
				const a = DEVICE_CAPABILITIES["shell.exec"].args.parse(rawArgs);
				return await execCommand(workspace, a.command);
			}
		}
	} catch (e) {
		const message =
			e instanceof WorkspaceError
				? e.message
				: e instanceof Error && e.name === "ZodError"
					? "参数不合法"
					: `执行出错：${e instanceof Error ? e.message : String(e)}`;
		return { ok: false, output: message };
	}
}

function ok(output: string): JobOutcome {
	return { ok: true, output: truncateOutput(output) };
}
