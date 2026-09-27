/**
 * Runner 看护：以子进程运行 `serve`，意外退出后按退避重启；本人主动停止后不再拉起。
 * 子进程的每一行输出交给 onLog（写日志文件），并从中推出连接状态。
 * 进程的起停经注入的 spawn 完成，本模块不碰 Electron 与真实进程，便于单测。
 */
import { restartDelay, STABLE_RUN_MS } from "@/main/backoff";
import {
	INITIAL_LINK,
	LineSplitter,
	type LinkState,
	parseLogLine,
	reduceLink,
} from "@/main/runner-log";

export type ProcessState =
	| "unpaired"
	| "stopped"
	| "running"
	| "restarting"
	| "stopping";

export type RunnerStatus = {
	process: ProcessState;
	pid: number | null;
	/** 当前（或最近一次）serve 进程日志推出的连接状态。 */
	link: LinkState;
	/** 本次启动以来意外退出后重启的次数。 */
	restarts: number;
	/** 排定的下一次重启时间（毫秒时间戳）。 */
	nextRestartAt: number | null;
	lastExit: { code: number | null; signal: string | null; at: string } | null;
};

/** 菜单栏图标的四种状态。 */
export type RunnerPhase = "connected" | "reconnecting" | "stopped" | "unpaired";

export function phaseOf(s: RunnerStatus): RunnerPhase {
	if (s.process === "unpaired") return "unpaired";
	if (s.process === "stopped" || s.process === "stopping") return "stopped";
	if (s.process === "running" && s.link.link === "connected")
		return "connected";
	return "reconnecting";
}

/** 进行中的事：设备操作与外部助手会话（只在进程运行时有意义）。 */
export function busyCount(s: RunnerStatus): number {
	return s.process === "running" ? s.link.jobs + s.link.sessions : 0;
}

export interface ChildHandle {
	readonly pid: number | undefined;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export type SpawnHooks = {
	onOutput: (chunk: string) => void;
	onExit: (code: number | null, signal: string | null) => void;
};

export type SpawnRunner = (hooks: SpawnHooks) => ChildHandle;

type Timer = ReturnType<typeof setTimeout>;

export type SupervisorDeps = {
	spawn: SpawnRunner;
	isPaired: () => boolean;
	onLog: (line: string) => void;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => Timer;
	clearTimer?: (t: Timer) => void;
	/** 发出 SIGTERM 后等多久改发 SIGKILL。 */
	stopGraceMs?: number;
};

export class RunnerSupervisor {
	private state: RunnerStatus;
	private readonly listeners = new Set<(s: RunnerStatus) => void>();
	private child: ChildHandle | null = null;
	private wanted = false;
	private attempt = 0;
	private startedAt = 0;
	private restartTimer: Timer | null = null;
	private killTimer: Timer | null = null;
	private exitWaiters: Array<() => void> = [];
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => Timer;
	private readonly clearTimer: (t: Timer) => void;

	constructor(private readonly deps: SupervisorDeps) {
		this.now = deps.now ?? Date.now;
		this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
		this.state = {
			process: deps.isPaired() ? "stopped" : "unpaired",
			pid: null,
			link: INITIAL_LINK,
			restarts: 0,
			nextRestartAt: null,
			lastExit: null,
		};
	}

	get status(): RunnerStatus {
		return this.state;
	}

	/** 是否处于"应当运行"（本人启动过且没有停止）。 */
	get wantsRunning(): boolean {
		return this.wanted;
	}

	subscribe(fn: (s: RunnerStatus) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private set(patch: Partial<RunnerStatus>): void {
		this.state = { ...this.state, ...patch };
		for (const fn of this.listeners) fn(this.state);
	}

	private note(level: "info" | "warn", event: string, fields: object): void {
		this.deps.onLog(
			`${new Date(this.now()).toISOString()} ${level} ${event} ${JSON.stringify(fields)}`,
		);
	}

	/** 配对信息变化后（配对成功、解除配对）重新判断。 */
	refreshPaired(): void {
		if (this.child) return;
		if (!this.deps.isPaired()) {
			this.cancelRestart();
			this.set({ process: "unpaired", nextRestartAt: null });
		} else if (this.state.process === "unpaired") {
			this.set({ process: "stopped" });
		}
	}

	start(): void {
		this.wanted = true;
		this.cancelRestart();
		this.attempt = 0;
		if (this.child) return;
		this.set({ restarts: 0 });
		this.launch();
	}

	async stop(): Promise<void> {
		this.wanted = false;
		this.cancelRestart();
		const child = this.child;
		if (!child) {
			this.set({
				process: this.deps.isPaired() ? "stopped" : "unpaired",
				nextRestartAt: null,
			});
			return;
		}
		const exited = new Promise<void>((resolve) =>
			this.exitWaiters.push(resolve),
		);
		if (this.state.process !== "stopping") {
			this.set({ process: "stopping" });
			child.kill("SIGTERM");
			this.killTimer = this.setTimer(() => {
				this.killTimer = null;
				if (this.child === child) child.kill("SIGKILL");
			}, this.deps.stopGraceMs ?? 5_000);
		}
		await exited;
	}

	async restart(): Promise<void> {
		await this.stop();
		this.start();
	}

	private cancelRestart(): void {
		if (this.restartTimer) this.clearTimer(this.restartTimer);
		this.restartTimer = null;
	}

	private launch(): void {
		if (!this.deps.isPaired()) {
			this.set({ process: "unpaired", pid: null, nextRestartAt: null });
			return;
		}
		const splitter = new LineSplitter();
		let link: LinkState = {
			...INITIAL_LINK,
			lastConnectedAt: this.state.link.lastConnectedAt,
		};
		const onLine = (line: string) => {
			this.deps.onLog(line);
			const entry = parseLogLine(line);
			if (!entry || this.child !== child) return;
			link = reduceLink(link, entry);
			if (link.link === "connected") this.attempt = 0;
			if (link !== this.state.link) this.set({ link });
		};
		this.startedAt = this.now();
		const child: ChildHandle = this.deps.spawn({
			onOutput: (chunk) => {
				for (const line of splitter.push(chunk)) onLine(line);
			},
			onExit: (code, signal) => {
				for (const line of splitter.flush()) onLine(line);
				this.exited(child, code, signal);
			},
		});
		this.child = child;
		this.set({
			process: "running",
			pid: child.pid ?? null,
			link,
			nextRestartAt: null,
		});
		this.note("info", "desktop.runner_started", { pid: child.pid ?? null });
	}

	private exited(
		child: ChildHandle,
		code: number | null,
		signal: string | null,
	): void {
		if (this.child !== child) return;
		this.child = null;
		if (this.killTimer) this.clearTimer(this.killTimer);
		this.killTimer = null;
		const lastExit = { code, signal, at: new Date(this.now()).toISOString() };
		const waiters = this.exitWaiters.splice(0);
		if (!this.wanted) {
			this.note("info", "desktop.runner_stopped", { code, signal });
			this.set({
				process: this.deps.isPaired() ? "stopped" : "unpaired",
				pid: null,
				lastExit,
				nextRestartAt: null,
			});
			for (const w of waiters) w();
			return;
		}
		if (this.now() - this.startedAt >= STABLE_RUN_MS) this.attempt = 0;
		const delay = restartDelay(this.attempt);
		this.attempt += 1;
		this.note("warn", "desktop.runner_exited", {
			code,
			signal,
			restartInMs: delay,
		});
		this.set({
			process: "restarting",
			pid: null,
			lastExit,
			restarts: this.state.restarts + 1,
			nextRestartAt: this.now() + delay,
		});
		this.restartTimer = this.setTimer(() => {
			this.restartTimer = null;
			if (this.wanted && !this.child) this.launch();
		}, delay);
		for (const w of waiters) w();
	}
}
