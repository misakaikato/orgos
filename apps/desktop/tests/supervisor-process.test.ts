/**
 * 看护真实的 Runner 进程（用 bun 直接跑 apps/runner 的源码）：连不上服务端时显示重连中，
 * 被杀掉后自动重启，主动停止后不再拉起；app 上次遗留的 Runner 进程按 pid 文件清理。
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPaired, runnerEnv, serveArgs } from "@/main/runner-cli";
import {
	killOrphanRunner,
	spawnRunner,
	writeRunnerPid,
} from "@/main/runner-process";
import { phaseOf, RunnerSupervisor } from "@/main/supervisor";

const RUNNER_MAIN = fileURLToPath(
	new URL("../../runner/src/main.ts", import.meta.url),
);

let dir: string;
let env: NodeJS.ProcessEnv;
const logs: string[] = [];

async function until<T>(
	what: string,
	fn: () => T | null | false,
	ms = 10_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
		await Bun.sleep(25);
	}
}

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), "orgos-desktop-sup-"));
	const home = path.join(dir, "runner-home");
	mkdirSync(home);
	// 端口 1 上没有服务：Runner 会一直处于重连阶梯。
	writeFileSync(
		path.join(home, "runner.json"),
		JSON.stringify({
			server: "http://127.0.0.1:1",
			runnerId: "00000000-0000-4000-8000-000000000009",
			token: "test-token",
		}),
	);
	env = runnerEnv(
		{ ...process.env, ORGOS_RUNNER_HOME: home },
		process.env.PATH ?? "",
	);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("看护真实 Runner 进程", () => {
	it("重连中 → 被杀后自动重启 → 停止后不再拉起", async () => {
		expect(isPaired(env, "/nonexistent")).toBe(true);
		const sup = new RunnerSupervisor({
			isPaired: () => isPaired(env, "/nonexistent"),
			onLog: (line) => logs.push(line),
			spawn: (hooks) =>
				spawnRunner(
					{
						binary: process.execPath,
						args: [RUNNER_MAIN, ...serveArgs(path.join(dir, "ws"), "none")],
						env,
						cwd: dir,
					},
					hooks,
				),
		});
		sup.start();
		const firstPid = sup.status.pid;
		expect(firstPid).toBeNumber();
		await until(
			"日志推出重连中",
			() => sup.status.link.link === "reconnecting",
		);
		expect(phaseOf(sup.status)).toBe("reconnecting");
		expect(logs.some((l) => l.includes(" info serve "))).toBe(true);
		expect(logs.join("\n")).not.toContain("test-token");

		process.kill(firstPid as number, "SIGKILL");
		await until("进入等待重启", () => sup.status.process === "restarting");
		expect(sup.status.lastExit?.signal).toBe("SIGKILL");
		await until(
			"自动重启",
			() => sup.status.process === "running" && sup.status.pid !== firstPid,
			5_000,
		);
		expect(sup.status.restarts).toBe(1);
		await until(
			"重启后的进程也在重连",
			() => sup.status.link.link === "reconnecting",
		);

		const secondPid = sup.status.pid;
		await sup.stop();
		expect(sup.status.process).toBe("stopped");
		expect(sup.status.lastExit).toMatchObject({ code: 0, signal: null });
		await Bun.sleep(1_500);
		expect(sup.status.process).toBe("stopped");
		expect(() => process.kill(secondPid as number, 0)).toThrow();
	}, 30_000);
});

describe("遗留的 Runner 进程", () => {
	it("pid 文件指向同一二进制时结束它，别的进程不碰", async () => {
		const pidFile = path.join(dir, "runner.pid");
		const orphan = Bun.spawn(["/bin/sleep", "30"]);
		writeRunnerPid(pidFile, orphan.pid);
		expect(killOrphanRunner(pidFile, "/bin/nope")).toBeNull();
		expect(orphan.killed).toBe(false);
		writeRunnerPid(pidFile, orphan.pid);
		expect(killOrphanRunner(pidFile, "/bin/sleep")).toBe(orphan.pid);
		await orphan.exited;
		expect(orphan.signalCode).toBe("SIGTERM");
		expect(killOrphanRunner(pidFile, "/bin/sleep")).toBeNull();
	});
});
