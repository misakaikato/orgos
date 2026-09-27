/**
 * Runner 子进程意外退出后的重启间隔：1s 起，每次翻倍，封顶 60s。
 * 子进程连上服务端或稳定运行满 STABLE_RUN_MS 后，重启计数归零。
 */
export const RESTART_MIN_MS = 1_000;
export const RESTART_MAX_MS = 60_000;
export const STABLE_RUN_MS = 60_000;

/** 第 attempt 次重启（从 0 起）前等待的毫秒数。 */
export function restartDelay(attempt: number): number {
	const n = Math.max(0, Math.floor(attempt));
	return Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.min(n, 30));
}
