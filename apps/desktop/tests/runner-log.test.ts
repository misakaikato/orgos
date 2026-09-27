import { describe, expect, it } from "bun:test";
import { RESTART_MAX_MS, restartDelay } from "@/main/backoff";
import {
	INITIAL_LINK,
	LineSplitter,
	type LinkState,
	parseLogLine,
	reduceLink,
} from "@/main/runner-log";

describe("重启退避", () => {
	it("1s 起每次翻倍，封顶 60s", () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7].map(restartDelay)).toEqual([
			1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
		]);
		expect(restartDelay(1_000)).toBe(RESTART_MAX_MS);
		expect(restartDelay(-3)).toBe(1_000);
	});
});

describe("日志行解析", () => {
	it("带字段的行", () => {
		expect(
			parseLogLine('2026-09-27T04:00:00.123Z info ws.open {"attempt":2}'),
		).toEqual({
			time: "2026-09-27T04:00:00.123Z",
			level: "info",
			event: "ws.open",
			fields: { attempt: 2 },
		});
	});

	it("不带字段的行", () => {
		expect(
			parseLogLine("2026-09-27T04:00:00.000Z info ws.closed_by_runner"),
		).toMatchObject({ event: "ws.closed_by_runner", fields: {} });
	});

	it("字段里含空格与中文", () => {
		const e = parseLogLine(
			'2026-09-27T04:00:00.000Z warn ws.disconnected {"reason":"close event 1006 连接中断","wasOpen":true}',
		);
		expect(e?.fields.reason).toBe("close event 1006 连接中断");
	});

	it("不是日志格式的行返回 null", () => {
		for (const line of [
			"还没有配对：找不到 /tmp/x/runner.json，先运行 pair",
			"",
			"2026-09-27T04:00:00.000Z",
			"2026-09-27T04:00:00.000Z verbose x",
			"yesterday info ws.open",
			'2026-09-27T04:00:00.000Z info ws.open {"broken"',
			"2026-09-27T04:00:00.000Z info ws.open [1,2]",
		])
			expect(parseLogLine(line)).toBeNull();
	});
});

function feed(lines: string[], from: LinkState = INITIAL_LINK): LinkState {
	return lines.reduce((s, line) => {
		const e = parseLogLine(line);
		return e ? reduceLink(s, e) : s;
	}, from);
}

const T = (n: number) => `2026-09-27T04:00:0${n}.000Z`;

describe("日志推出连接状态", () => {
	it("首次连上：连接中 → 已连接，并记下时间", () => {
		const s = feed([
			`${T(0)} info serve {"runnerId":"r","workspace":"/w","adapters":[]}`,
			`${T(1)} info ws.connecting {"url":"ws://x/runner/ws","attempt":1}`,
		]);
		expect(s.link).toBe("connecting");
		const after = feed([`${T(2)} info ws.open {"attempt":1}`], s);
		expect(after).toMatchObject({ link: "connected", lastConnectedAt: T(2) });
	});

	it("断开后重连中，重连成功再回到已连接", () => {
		const s = feed([
			`${T(1)} info ws.open {"attempt":1}`,
			`${T(2)} warn ws.disconnected {"reason":"pong timeout after 15000ms","wasOpen":true,"readyState":1}`,
			`${T(3)} info ws.reconnect_scheduled {"inMs":1000}`,
			`${T(4)} info ws.connecting {"url":"ws://x","attempt":2}`,
		]);
		expect(s.link).toBe("reconnecting");
		expect(s.lastConnectedAt).toBe(T(1));
		expect(s.lastProblem).toBe("ws.disconnected：pong timeout after 15000ms");
		expect(feed([`${T(5)} info ws.open {"attempt":2}`], s)).toMatchObject({
			link: "connected",
			lastConnectedAt: T(5),
		});
	});

	it("从未连上时的连接失败也是重连中", () => {
		const s = feed([
			`${T(1)} info ws.connecting {"attempt":1}`,
			`${T(2)} warn ws.disconnected {"reason":"error event"}`,
		]);
		expect(s.link).toBe("reconnecting");
	});

	it("load 事件给出进行中的数量，不合法的值不采用", () => {
		const s = feed([
			`${T(1)} info load {"jobs":2,"sessions":1}`,
			`${T(2)} info load {"jobs":-1,"sessions":"x"}`,
		]);
		expect(s).toMatchObject({ jobs: 2, sessions: 1 });
		expect(
			feed([`${T(3)} info load {"jobs":0,"sessions":0}`], s),
		).toMatchObject({ jobs: 0, sessions: 0 });
	});

	it("其他警告与错误记为最近问题，普通信息不改状态", () => {
		const s = feed([`${T(1)} error acp.spawn_error {"message":"ENOENT"}`]);
		expect(s.lastProblem).toBe("acp.spawn_error：ENOENT");
		const same = parseLogLine(`${T(2)} info job.start {"jobId":"j"}`);
		expect(same && reduceLink(s, same)).toBe(s);
	});
});

describe("按行切分输出", () => {
	it("跨块拼接、去掉 \\r、流结束交出残余", () => {
		const sp = new LineSplitter();
		expect(sp.push("第一")).toEqual([]);
		expect(sp.push("行\r\n第二行\n第")).toEqual(["第一行", "第二行"]);
		expect(sp.push("三")).toEqual([]);
		expect(sp.flush()).toEqual(["第三"]);
		expect(sp.flush()).toEqual([]);
	});
});
