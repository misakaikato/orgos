/**
 * 起第三方 ACP agent 进程——安全面在这里，不在别处。三条铁律，逐条有断言（tests/acp-spawn.test.ts）：
 *
 * 1. 子进程看不到 runner token 与服务器地址。两道一起上：
 *      a. 交给子进程的 env 对象里就没有 `SCRUBBED_ENV_KEYS`（`scrubEnv`）；
 *      b. 命令再包一层 `/usr/bin/env -u …`（`scrubEnvWrap`）。
 *    b 在 a 已经做到时是冗余的——刻意保留：它让这条保证出现在进程的命令行上（`ps` 看得见），
 *    而不是只存在于一段谁都可能改掉的对象构造代码里；且不经 shell，注入面为零。
 *    token 本身只在 Runner 的内存里（读自 runner.json），从不进任何环境变量。
 *
 * 2. orgos 不注入任何厂商密钥。子进程的环境 = Runner 自己的环境去掉上述键，再并上适配器表里
 *    写死的开关（表里一个密钥都没有，`enforceAcpConfig` 也拒绝任何被清洗的键名）。
 *    个人模式下外部 agent 用本人自己在这台设备上的登录；企业模式下按适配器表的注入规则
 *    只多给三样：网关地址（`<服务端>/llm`，只认任务令牌）、本会话的任务令牌、模型引用，
 *    并去掉设备主人自己的凭据与会绕开网关的开关——都只在本次子进程里，不碰任何配置文件。
 *
 * 3. stdio 是管道，不是 PTY。ACP 走 NDJSON over stdin/stdout，PTY 会插入回显与行编辑，
 *    把协议帧搅烂。
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
	type AcpConfig,
	SCRUBBED_ENV_KEYS,
	scrubEnvWrap,
} from "@orgos/protocol";
import { log } from "@/log";

const SCRUBBED: ReadonlySet<string> = new Set(SCRUBBED_ENV_KEYS);

/** 基础环境 → 交给第三方进程的环境：删掉被清洗的键，再并上适配器的开关（同样不许带回被清洗的键）。 */
export function scrubEnv(
	base: Record<string, string | undefined>,
	extra: Record<string, string>,
	alsoUnset: readonly string[] = [],
): Record<string, string> {
	const out: Record<string, string> = {};
	const drop = new Set(alsoUnset);
	for (const [k, v] of Object.entries(base)) {
		if (SCRUBBED.has(k) || drop.has(k)) continue;
		if (v !== undefined) out[k] = v;
	}
	for (const [k, v] of Object.entries(extra)) {
		if (SCRUBBED.has(k)) continue;
		out[k] = v;
	}
	return out;
}

/** 一条已装配好的启动命令（纯数据，便于逐字段断言）。 */
export interface AcpLaunchPlan {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
}

/** 装配启动计划（纯函数：不碰进程、不碰磁盘）。 */
export function buildLaunchPlan(
	config: AcpConfig,
	workspace: string,
	baseEnv: Record<string, string | undefined>,
	/** 企业模式下另外去掉的键。 */
	alsoUnset: readonly string[] = [],
): AcpLaunchPlan {
	const wrapped = scrubEnvWrap(config.command, config.args ?? [], alsoUnset);
	return {
		command: wrapped.command,
		args: wrapped.args,
		env: scrubEnv(baseEnv, config.env ?? {}, alsoUnset),
		cwd: workspace,
	};
}

export interface AcpProcess {
	/** 往它的 stdin 写一帧。 */
	write(frame: string): void;
	alive(): boolean;
	kill(): void;
	pid: number | undefined;
}

export interface AcpProcessDeps {
	plan: AcpLaunchPlan;
	/** stdout 到达（喂给 JSON-RPC 对等体）。 */
	onStdout: (chunk: string) => void;
	/** stderr 到达（第三方进程的诊断输出，只留档不进协议）。 */
	onStderr: (chunk: string) => void;
	/** 进程退出：必须让整个任务知道，否则等在响应上的调用会永远悬着。 */
	onExit: (code: number | null, signal: string | null) => void;
	/** 起进程的能力（默认 `child_process.spawn`；测试可注入）。 */
	spawner?: (plan: AcpLaunchPlan) => ChildProcess;
}

/** SIGTERM 之后等多久再 SIGKILL。 */
const KILL_GRACE_MS = 3_000;

const defaultSpawner = (plan: AcpLaunchPlan): ChildProcess =>
	spawn(plan.command, plan.args, {
		cwd: plan.cwd,
		env: plan.env,
		// 管道，不是 PTY（见文件头第 3 条）。
		stdio: ["pipe", "pipe", "pipe"],
		// 独立进程组：终止时连同它起的子进程（npx → node）一起收掉。
		detached: true,
	});

/** 起第三方 ACP agent 进程并接好三条流。 */
export function startAcpProcess(deps: AcpProcessDeps): AcpProcess {
	const child = (deps.spawner ?? defaultSpawner)(deps.plan);
	let exited = false;

	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => deps.onStdout(chunk));
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => deps.onStderr(chunk));
	// 进程一死，下一次往 stdin 写帧会异步抛 EPIPE；不接住会冲到 uncaughtException 把 Runner 带走。
	child.stdin?.on("error", (err: Error) => {
		log.warn("acp.stdin_error", { message: err.message });
	});
	child.on("exit", (code, signal) => {
		if (exited) return;
		exited = true;
		deps.onExit(code, signal ?? null);
	});
	child.on("error", (err) => {
		// spawn 本身失败（命令不存在 / 没有执行权限）：exit 不一定会来，这里也要收敛。
		if (exited) return;
		exited = true;
		log.error("acp.spawn_error", { message: err.message });
		deps.onExit(null, "spawn_error");
	});

	log.info("acp.process_started", {
		pid: child.pid,
		command: deps.plan.command,
		// 只记参数条数不记内容。
		argc: deps.plan.args.length,
		cwd: deps.plan.cwd,
	});

	return {
		write(frame) {
			if (exited) return;
			try {
				child.stdin?.write(frame);
			} catch (err) {
				log.warn("acp.write_failed", { message: (err as Error).message });
			}
		},
		alive: () => !exited,
		kill() {
			if (exited) return;
			const signalGroup = (signal: NodeJS.Signals) => {
				try {
					if (child.pid) process.kill(-child.pid, signal);
					else child.kill(signal);
				} catch {
					try {
						child.kill(signal);
					} catch {}
				}
			};
			signalGroup("SIGTERM");
			// 不理会 SIGTERM 的进程组，稍后强杀。
			setTimeout(() => {
				if (!exited) signalGroup("SIGKILL");
			}, KILL_GRACE_MS).unref?.();
		},
		pid: child.pid,
	};
}
