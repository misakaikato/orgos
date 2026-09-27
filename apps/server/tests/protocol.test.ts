import {
	HANDLE_RE,
	OnboardingRequestSchema,
	parseBrowserFrame,
} from "@orgos/protocol";
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

describe("代理运行帧", () => {
	const ids = {
		conversationId: "8a0b3c73-5249-4e52-af6e-84506d0eea3d",
		agentId: "4eb3877b-ea7e-4ab2-a310-667d28ca01ab",
		runId: "run-1",
	};

	it("draft 与 status 可解析；state 只能是 thinking / tool / idle", () => {
		expect(
			parseBrowserFrame(JSON.stringify({ t: "draft", ...ids, delta: "你好" })),
		).toMatchObject({ ok: true });
		expect(
			parseBrowserFrame(
				JSON.stringify({
					t: "status",
					...ids,
					state: "tool",
					label: "正在查资料…",
				}),
			),
		).toMatchObject({ ok: true });
		expect(
			parseBrowserFrame(JSON.stringify({ t: "status", ...ids, state: "busy" })),
		).toMatchObject({ ok: false });
	});
});
