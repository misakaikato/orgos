/**
 * ACP `terminal/*` → 在任务工作目录里执行命令（等同设备能力 shell.exec）。
 *
 * - 每条命令先过 `gate`：它把请求转成本人的审批（本话题内已始终允许、或同一命令刚在权限请求里
 *   批准过的，由 gate 直接放行并留记录），被拒绝则 `terminal/create` 以错误返回，命令不执行；
 * - cwd 必须在工作目录之内（与设备能力、fs 同一把路径校验）；
 * - stdio 是管道，不是 PTY；环境是已清洗过的（与 agent 进程本身同一套变量）；
 * - 输出有字节上限：超出后只保留尾部（命令的结论总在最后）；同时存活的终端数有上限；
 * - 独立进程组，kill / release / 任务结束时整组收掉。
 */

import type { AcpCreateTerminalParams, AcpTerminalRefParams } from "@/acp/wire";
import { log } from "@/log";
import { resolveExisting, WorkspaceError } from "@/workspace";

/** 单个终端的输出缓冲上限（agent 未指定 `outputByteLimit` 时）。 */
export const ACP_TERMINAL_OUTPUT_MAX = 1024 * 1024;
/** 同时存活的终端数上限。 */
export const ACP_MAX_TERMINALS = 8;

export type TerminalRequest = { command: string; cwd: string };

/** 审批闸门：返回是否允许执行；拒绝时给一句原因。 */
export type TerminalGate = (
	req: TerminalRequest,
) => Promise<{ allowed: true } | { allowed: false; reason: string }>;

export interface AcpTerminalExit {
	exitCode: number | null;
	signal: string | null;
}

export interface AcpTerminals {
	create(params: AcpCreateTerminalParams): Promise<{ terminalId: string }>;
	output(params: AcpTerminalRefParams): {
		output: string;
		truncated: boolean;
		exitStatus: AcpTerminalExit | null;
	};
	waitForExit(params: AcpTerminalRefParams): Promise<AcpTerminalExit>;
	kill(params: AcpTerminalRefParams): Record<string, never>;
	release(params: AcpTerminalRefParams): Record<string, never>;
	disposeAll(): void;
	count(): number;
}

interface TerminalRecord {
	proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	output: Buffer;
	limit: number;
	truncated: boolean;
	exit: AcpTerminalExit | null;
	waiters: ((exit: AcpTerminalExit) => void)[];
}

/** agent 给的命令：没有参数时整串交给 /bin/sh（Claude Code 等把完整命令行放在 command 里）。 */
export function commandLine(params: AcpCreateTerminalParams): string[] {
	const command = params.command ?? "";
	const args = params.args ?? [];
	return args.length === 0 ? ["/bin/sh", "-c", command] : [command, ...args];
}

function killGroup(rec: TerminalRecord): void {
	if (rec.exit) return;
	try {
		process.kill(-rec.proc.pid, "SIGKILL");
	} catch {
		rec.proc.kill("SIGKILL");
	}
}

export function createAcpTerminals(
	workspace: string,
	envBase: Record<string, string>,
	gate: TerminalGate,
): AcpTerminals {
	const terms = new Map<string, TerminalRecord>();
	let seq = 0;

	const get = (params: AcpTerminalRefParams): TerminalRecord => {
		const rec = terms.get(params.terminalId ?? "");
		if (!rec) throw new Error(`unknown terminal: ${params.terminalId}`);
		return rec;
	};

	const append = (rec: TerminalRecord, chunk: Uint8Array): void => {
		const next = Buffer.concat([rec.output, chunk]);
		if (next.length <= rec.limit) {
			rec.output = next;
			return;
		}
		rec.truncated = true;
		rec.output = next.subarray(next.length - rec.limit);
	};

	const drain = async (
		rec: TerminalRecord,
		stream: ReadableStream<Uint8Array>,
	) => {
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			append(rec, value);
		}
	};

	return {
		async create(params) {
			if (terms.size >= ACP_MAX_TERMINALS)
				throw new Error(`终端太多（最多 ${ACP_MAX_TERMINALS} 个）`);
			if (!params.command) throw new Error("terminal/create 缺少 command");
			const cwd = await resolveExisting(workspace, params.cwd ?? ".");
			const argv = commandLine(params);
			const verdict = await gate({
				command: argv[0] === "/bin/sh" ? (argv[2] ?? "") : argv.join(" "),
				cwd,
			});
			if (!verdict.allowed) throw new WorkspaceError(verdict.reason);
			const env: Record<string, string> = { ...envBase };
			for (const e of params.env ?? []) if (e.name) env[e.name] = e.value ?? "";
			const limit =
				typeof params.outputByteLimit === "number" && params.outputByteLimit > 0
					? Math.min(params.outputByteLimit, ACP_TERMINAL_OUTPUT_MAX)
					: ACP_TERMINAL_OUTPUT_MAX;
			seq += 1;
			const id = `term-${seq}`;
			const proc = Bun.spawn(argv, {
				cwd,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				detached: true,
			});
			const rec: TerminalRecord = {
				proc,
				output: Buffer.alloc(0),
				limit,
				truncated: false,
				exit: null,
				waiters: [],
			};
			terms.set(id, rec);
			const drained = Promise.all([
				drain(rec, proc.stdout),
				drain(rec, proc.stderr),
			]);
			void proc.exited.then(async (code) => {
				await Promise.race([drained, Bun.sleep(200)]);
				rec.exit = {
					exitCode: proc.signalCode ? null : code,
					signal: proc.signalCode ?? null,
				};
				for (const w of rec.waiters) w(rec.exit);
				rec.waiters.length = 0;
			});
			log.info("acp.terminal_created", { id, total: terms.size });
			return { terminalId: id };
		},

		output(params) {
			const rec = get(params);
			return {
				output: rec.output.toString("utf8"),
				truncated: rec.truncated,
				exitStatus: rec.exit,
			};
		},

		waitForExit(params) {
			const rec = get(params);
			if (rec.exit) return Promise.resolve(rec.exit);
			return new Promise<AcpTerminalExit>((resolve) => {
				rec.waiters.push(resolve);
			});
		},

		kill(params) {
			killGroup(get(params));
			return {};
		},

		/** agent 不再需要这个终端：还活着的进程一并收掉，仍在等退出的调用方放行。 */
		release(params) {
			const rec = terms.get(params.terminalId ?? "");
			if (!rec) return {};
			terms.delete(params.terminalId ?? "");
			killGroup(rec);
			for (const w of rec.waiters)
				w(rec.exit ?? { exitCode: null, signal: null });
			rec.waiters.length = 0;
			return {};
		},

		disposeAll() {
			for (const rec of terms.values()) {
				killGroup(rec);
				for (const w of rec.waiters)
					w(rec.exit ?? { exitCode: null, signal: null });
			}
			terms.clear();
		},

		count: () => terms.size,
	};
}
