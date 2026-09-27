import { describe, expect, it } from "bun:test";
import {
	busyCount,
	type ChildHandle,
	phaseOf,
	RunnerSupervisor,
	type SpawnHooks,
} from "@/main/supervisor";

/** 可手动推进的时钟与定时器。 */
class FakeClock {
	now = 1_000_000;
	private timers: Array<{ at: number; fn: () => void; id: number }> = [];
	private seq = 0;

	setTimer = (fn: () => void, ms: number) => {
		const id = ++this.seq;
		this.timers.push({ at: this.now + ms, fn, id });
		return id as unknown as ReturnType<typeof setTimeout>;
	};

	clearTimer = (t: ReturnType<typeof setTimeout>) => {
		this.timers = this.timers.filter((x) => x.id !== (t as unknown as number));
	};

	pending(): number[] {
		return this.timers.map((t) => t.at - this.now).sort((a, b) => a - b);
	}

	advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			const next = this.timers
				.filter((t) => t.at <= target)
				.sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			this.timers = this.timers.filter((t) => t !== next);
			this.now = next.at;
			next.fn();
		}
		this.now = target;
	}
}

class FakeChild implements ChildHandle {
	signals: string[] = [];
	constructor(
		readonly pid: number,
		readonly hooks: SpawnHooks,
	) {}
	kill(signal: "SIGTERM" | "SIGKILL"): void {
		this.signals.push(signal);
	}
	say(line: string): void {
		this.hooks.onOutput(`${line}\n`);
	}
	exit(code: number | null, signal: string | null = null): void {
		this.hooks.onExit(code, signal);
	}
}

function setup(paired = true) {
	const clock = new FakeClock();
	const children: FakeChild[] = [];
	const logs: string[] = [];
	const state = { paired };
	const sup = new RunnerSupervisor({
		spawn: (hooks) => {
			const child = new FakeChild(100 + children.length, hooks);
			children.push(child);
			return child;
		},
		isPaired: () => state.paired,
		onLog: (line) => logs.push(line),
		now: () => clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		stopGraceMs: 5_000,
	});
	const last = () => {
		const c = children.at(-1);
		if (!c) throw new Error("还没有起过进程");
		return c;
	};
	return { clock, children, logs, state, sup, last };
}

const OPEN = '2026-09-27T04:00:00.000Z info ws.open {"attempt":1}';

describe("Runner 看护", () => {
	it("未配对时不起进程", () => {
		const { sup, children } = setup(false);
		expect(phaseOf(sup.status)).toBe("unpaired");
		sup.start();
		expect(children).toHaveLength(0);
		expect(sup.status.process).toBe("unpaired");
	});

	it("启动后按日志进入已连接，输出逐行写日志", () => {
		const { sup, last, logs } = setup();
		expect(phaseOf(sup.status)).toBe("stopped");
		sup.start();
		expect(sup.status).toMatchObject({ process: "running", pid: 100 });
		expect(phaseOf(sup.status)).toBe("reconnecting");
		last().hooks.onOutput("2026-09-27T04:00:00.000Z info ws.conn");
		last().hooks.onOutput('ecting {"attempt":1}\n');
		last().say(OPEN);
		expect(phaseOf(sup.status)).toBe("connected");
		expect(logs).toContain(
			'2026-09-27T04:00:00.000Z info ws.connecting {"attempt":1}',
		);
		expect(logs).toContain(OPEN);
	});

	it("意外退出按 1s、2s、4s 退避重启；连上后归零", () => {
		const { sup, children, clock, last } = setup();
		sup.start();
		last().exit(1);
		expect(sup.status).toMatchObject({ process: "restarting", restarts: 1 });
		expect(clock.pending()).toEqual([1_000]);
		clock.advance(999);
		expect(children).toHaveLength(1);
		clock.advance(1);
		expect(children).toHaveLength(2);
		last().exit(null, "SIGKILL");
		expect(clock.pending()).toEqual([2_000]);
		clock.advance(2_000);
		last().exit(1);
		expect(clock.pending()).toEqual([4_000]);
		clock.advance(4_000);
		expect(children).toHaveLength(4);
		last().say(OPEN);
		last().exit(0);
		expect(clock.pending()).toEqual([1_000]);
		expect(sup.status.restarts).toBe(4);
		expect(sup.status.lastExit).toMatchObject({ code: 0 });
	});

	it("稳定运行满 60s 后退出，也从 1s 重新算", () => {
		const { sup, clock, last } = setup();
		sup.start();
		last().exit(1);
		clock.advance(1_000);
		last().exit(1);
		clock.advance(2_000);
		clock.advance(61_000);
		last().exit(1);
		expect(clock.pending()).toEqual([1_000]);
	});

	it("被杀掉（哪怕退出码 0）也视为意外退出并重启", () => {
		const { sup, children, clock, last } = setup();
		sup.start();
		last().say(OPEN);
		last().exit(0, null);
		expect(phaseOf(sup.status)).toBe("reconnecting");
		clock.advance(1_000);
		expect(children).toHaveLength(2);
		expect(sup.status.process).toBe("running");
		expect(sup.status.link.lastConnectedAt).toBe("2026-09-27T04:00:00.000Z");
	});

	it("主动停止：先 SIGTERM，退出后不再拉起", async () => {
		const { sup, children, clock, last } = setup();
		sup.start();
		const child = last();
		const stopping = sup.stop();
		expect(sup.status.process).toBe("stopping");
		expect(phaseOf(sup.status)).toBe("stopped");
		expect(child.signals).toEqual(["SIGTERM"]);
		child.exit(0);
		await stopping;
		expect(sup.status.process).toBe("stopped");
		clock.advance(120_000);
		expect(children).toHaveLength(1);
		expect(sup.wantsRunning).toBe(false);
	});

	it("停止时进程不理 SIGTERM，宽限期后 SIGKILL", async () => {
		const { sup, clock, last } = setup();
		sup.start();
		const child = last();
		const stopping = sup.stop();
		clock.advance(5_000);
		expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
		child.exit(null, "SIGKILL");
		await stopping;
		expect(sup.status.process).toBe("stopped");
	});

	it("等待重启期间停止：取消重启", async () => {
		const { sup, children, clock, last } = setup();
		sup.start();
		last().exit(1);
		await sup.stop();
		clock.advance(60_000);
		expect(children).toHaveLength(1);
		expect(sup.status.process).toBe("stopped");
	});

	it("解除配对后停在未配对；重新配对后可再启动", async () => {
		const { sup, state, children, last } = setup();
		sup.start();
		const stopping = sup.stop();
		last().exit(0);
		await stopping;
		state.paired = false;
		sup.refreshPaired();
		expect(phaseOf(sup.status)).toBe("unpaired");
		state.paired = true;
		sup.refreshPaired();
		expect(phaseOf(sup.status)).toBe("stopped");
		sup.start();
		expect(children).toHaveLength(2);
	});

	it("等待重启时发现配对已删：停在未配对", () => {
		const { sup, state, children, clock, last } = setup();
		sup.start();
		last().exit(1);
		state.paired = false;
		clock.advance(1_000);
		expect(children).toHaveLength(1);
		expect(sup.status.process).toBe("unpaired");
	});

	it("进行中的事只在运行时计数", () => {
		const { sup, last } = setup();
		sup.start();
		last().say('2026-09-27T04:00:00.000Z info load {"jobs":1,"sessions":2}');
		expect(busyCount(sup.status)).toBe(3);
		last().exit(1);
		expect(busyCount(sup.status)).toBe(0);
	});

	it("退出事件之前没换行的最后一段也会写进日志", () => {
		const { sup, last, logs } = setup();
		sup.start();
		last().hooks.onOutput("还没有配对：找不到 runner.json");
		last().exit(1);
		expect(logs).toContain("还没有配对：找不到 runner.json");
	});
});
