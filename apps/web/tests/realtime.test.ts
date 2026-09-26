import { describe, expect, it } from "vitest";
import { backoffDelay } from "@/lib/realtime";

describe("backoffDelay", () => {
	it("1s 起步、指数增长、30s 封顶", () => {
		const mid = () => 0.5;
		expect([0, 1, 2, 3, 4, 5, 6, 10].map((n) => backoffDelay(n, mid))).toEqual([
			1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
		]);
	});

	it("抖动在 ±20% 以内", () => {
		expect(backoffDelay(0, () => 0)).toBe(800);
		expect(backoffDelay(0, () => 1)).toBe(1200);
		expect(backoffDelay(10, () => 1)).toBe(36000);
	});
});
