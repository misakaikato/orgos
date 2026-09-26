import { HANDLE_RE, OnboardingRequestSchema } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import { newInviteCode, normalizeInviteCode } from "@/services/onboarding";

describe("handle 规则", () => {
	it.each(["ab", "alice", "a1-b2", `a${"b".repeat(30)}`])("接受 %s", (h) => {
		expect(HANDLE_RE.test(h)).toBe(true);
	});
	it.each(["a", "1abc", "Alice", "a_b", "a b", `a${"b".repeat(31)}`, "-ab"])(
		"拒绝 %s",
		(h) => {
			expect(HANDLE_RE.test(h)).toBe(false);
		},
	);
});

describe("OnboardingRequestSchema", () => {
	it("create 需要 orgName", () => {
		const ok = OnboardingRequestSchema.safeParse({
			mode: "create",
			orgName: "测试公司",
			displayName: "Alice",
			handle: "alice",
		});
		expect(ok.success).toBe(true);
		const missing = OnboardingRequestSchema.safeParse({
			mode: "create",
			displayName: "Alice",
			handle: "alice",
		});
		expect(missing.success).toBe(false);
	});

	it("join 需要 inviteCode", () => {
		expect(
			OnboardingRequestSchema.safeParse({
				mode: "join",
				inviteCode: "ABC",
				displayName: "Bob",
				handle: "bob",
			}).success,
		).toBe(true);
		expect(
			OnboardingRequestSchema.safeParse({
				mode: "join",
				displayName: "Bob",
				handle: "bob",
			}).success,
		).toBe(false);
	});

	it("拒绝未知 mode 与空白显示名", () => {
		expect(
			OnboardingRequestSchema.safeParse({
				mode: "x",
				displayName: "A",
				handle: "ab",
			}).success,
		).toBe(false);
		expect(
			OnboardingRequestSchema.safeParse({
				mode: "create",
				orgName: "o",
				displayName: "   ",
				handle: "ab",
			}).success,
		).toBe(false);
	});
});

describe("邀请码", () => {
	it("10 位、只含无歧义的大写字母与数字", () => {
		for (let i = 0; i < 50; i++) {
			expect(newInviteCode()).toMatch(/^[A-HJKMNP-Z2-9]{10}$/);
		}
	});
	it("比对前去空白并转大写", () => {
		expect(normalizeInviteCode("  abcd23 ")).toBe("ABCD23");
	});
});
