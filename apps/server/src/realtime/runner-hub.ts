/**
 * 设备 Runner 的连接与 job：每台设备至多一条在线连接，向它下发 invoke 并按 jobId 收结果。
 *
 * 纯逻辑，不依赖 Bun / Hono / 数据库。连接以对象引用区分：路由层每条连接只包一次
 * （见 `@/realtime/runner-ws`），attach、detach、onFrame 必须传同一个对象。
 *
 * - 新连接顶掉同一设备的旧连接（旧连接以 4001 关闭）；只有当前连接的断开才算下线；
 * - job 并行，各自计时：60s 内没有结果即失败；设备不在线时立即失败；
 * - 断线不立即判 job 失败：Runner 重连后仍可在新连接上交回结果，否则到点超时。
 */
import {
	type DeviceCapabilityName,
	RUNNER_JOB_TIMEOUT_MS,
	RUNNER_WS_CLOSE,
	type RunnerDown,
	type RunnerUp,
	truncateOutput,
} from "@orgos/protocol";

export interface RunnerSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export type JobResult = { ok: boolean; output: string; exitCode?: number };

export const OFFLINE_TEXT = "设备离线";
export const ABORTED_TEXT = "操作已中止";

export function timeoutText(ms: number): string {
	return `设备在 ${Math.round(ms / 1000)} 秒内没有返回结果`;
}

type Job = {
	runnerId: string;
	settle: (r: JobResult) => void;
};

export class RunnerHub {
	private readonly conns = new Map<string, RunnerSocket>();
	private readonly jobs = new Map<string, Job>();
	private seq = 0;

	constructor(private readonly jobTimeoutMs = RUNNER_JOB_TIMEOUT_MS) {}

	/** 登记设备的当前连接；已有另一条连接时把它关掉。 */
	attach(runnerId: string, sock: RunnerSocket): void {
		const old = this.conns.get(runnerId);
		this.conns.set(runnerId, sock);
		if (old && old !== sock)
			closeSafe(old, RUNNER_WS_CLOSE.REPLACED, "replaced");
	}

	/** 连接断开；返回它是否是该设备的当前连接（是才算下线）。 */
	detach(runnerId: string, sock: RunnerSocket): boolean {
		if (this.conns.get(runnerId) !== sock) return false;
		this.conns.delete(runnerId);
		return true;
	}

	isOnline(runnerId: string): boolean {
		return this.conns.has(runnerId);
	}

	/** 断开设备（吊销）：以给定关闭码关闭并注销。 */
	kick(runnerId: string, code: number, reason: string): void {
		const sock = this.conns.get(runnerId);
		if (!sock) return;
		this.conns.delete(runnerId);
		closeSafe(sock, code, reason);
	}

	/** 处理一帧上行（hello 由调用方处理）：ping 回 pong；result 交给等待的 job。 */
	onFrame(runnerId: string, sock: RunnerSocket, frame: RunnerUp): void {
		if (frame.t === "ping") {
			sendSafe(sock, { t: "pong" });
			return;
		}
		if (frame.t !== "result") return;
		const job = this.jobs.get(frame.jobId);
		if (!job || job.runnerId !== runnerId) return;
		job.settle({
			ok: frame.ok,
			output: truncateOutput(frame.output),
			...(frame.exitCode === undefined ? {} : { exitCode: frame.exitCode }),
		});
	}

	/** 在设备上执行一项能力，等结果。不在线立即失败；超时、中止都以失败返回，不抛异常。 */
	invoke(
		runnerId: string,
		capability: DeviceCapabilityName,
		args: unknown,
		signal?: AbortSignal,
	): Promise<JobResult> {
		const sock = this.conns.get(runnerId);
		if (!sock) return Promise.resolve({ ok: false, output: OFFLINE_TEXT });
		if (signal?.aborted)
			return Promise.resolve({ ok: false, output: ABORTED_TEXT });
		const jobId = `j${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
		return new Promise<JobResult>((resolve) => {
			const timer = setTimeout(
				() => settle({ ok: false, output: timeoutText(this.jobTimeoutMs) }),
				this.jobTimeoutMs,
			);
			const onAbort = () => settle({ ok: false, output: ABORTED_TEXT });
			const settle = (r: JobResult) => {
				if (!this.jobs.delete(jobId)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(r);
			};
			this.jobs.set(jobId, { runnerId, settle });
			signal?.addEventListener("abort", onAbort, { once: true });
			if (!sendSafe(sock, { t: "invoke", jobId, capability, args }))
				settle({ ok: false, output: OFFLINE_TEXT });
		});
	}

	/** 进行中的 job 数（测试用）。 */
	pendingJobs(): number {
		return this.jobs.size;
	}
}

function sendSafe(sock: RunnerSocket, frame: RunnerDown): boolean {
	try {
		sock.send(JSON.stringify(frame));
		return true;
	} catch {
		return false;
	}
}

function closeSafe(sock: RunnerSocket, code: number, reason: string): void {
	try {
		sock.close(code, reason);
	} catch {
		// 对端已断开。
	}
}

export const runnerHub = new RunnerHub();
