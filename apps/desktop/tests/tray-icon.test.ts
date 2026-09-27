import { describe, expect, it } from "bun:test";
import type { RunnerPhase } from "@/main/supervisor";
import { PHASE_LABEL, TRAY_POINTS, trayBitmap } from "@/main/tray-icon";

const PHASES: RunnerPhase[] = [
	"connected",
	"reconnecting",
	"stopped",
	"unpaired",
];

function alphaAt(buf: Buffer, size: number, x: number, y: number): number {
	return buf[(y * size + x) * 4 + 3] ?? -1;
}

describe("菜单栏图标", () => {
	it("位图尺寸按倍数，颜色通道全 0（模板图只看透明度）", () => {
		for (const scale of [1, 2]) {
			const size = TRAY_POINTS * scale;
			const buf = trayBitmap("connected", scale);
			expect(buf.length).toBe(size * size * 4);
			for (let i = 0; i < buf.length; i += 4) {
				expect(buf[i]).toBe(0);
				expect(buf[i + 1]).toBe(0);
				expect(buf[i + 2]).toBe(0);
			}
		}
	});

	it("已连接为实心，其余中心透明；四种状态各不相同", () => {
		const size = TRAY_POINTS * 2;
		const center = size / 2;
		expect(alphaAt(trayBitmap("connected", 2), size, center, center)).toBe(255);
		expect(alphaAt(trayBitmap("stopped", 2), size, center, center)).toBe(0);
		expect(alphaAt(trayBitmap("reconnecting", 2), size, center, center)).toBe(
			0,
		);
		const drawn = PHASES.map((p) => trayBitmap(p, 2).toString("base64"));
		expect(new Set(drawn).size).toBe(PHASES.length);
	});

	it("未配对比已停止多一道斜线，重连中比已停止少两段", () => {
		const ink = (p: RunnerPhase) =>
			[...trayBitmap(p, 2)]
				.filter((_, i) => i % 4 === 3)
				.reduce((a, b) => a + b, 0);
		expect(ink("unpaired")).toBeGreaterThan(ink("stopped"));
		expect(ink("reconnecting")).toBeLessThan(ink("stopped"));
	});

	it("每种状态都有中文名", () => {
		expect(PHASES.map((p) => PHASE_LABEL[p])).toEqual([
			"已连接",
			"重连中",
			"已停止",
			"未配对",
		]);
	});
});
