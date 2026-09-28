import type { Event, Principal } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import { describeEvent, previewOf } from "@/lib/describe";

const TENANT = "44444444-4444-4444-8444-444444444444";
const CONV = "55555555-5555-4555-8555-555555555555";
const AT = "2026-09-27T09:00:00.000Z";
const LIN = "11111111-1111-4111-8111-111111111111";
const LIN_TWIN = "22222222-2222-4222-8222-222222222222";
const ZHOU = "33333333-3333-4333-8333-333333333333";
const XU = "66666666-6666-4666-8666-666666666666";

function person(id: string, displayName: string): Principal {
	return {
		id,
		tenantId: TENANT,
		kind: "human",
		userId: `u-${id}`,
		ownerId: null,
		handle: `h${id.slice(0, 4)}`,
		displayName,
		createdAt: AT,
		status: "available",
	};
}

const map = new Map<string, Principal>([
	[LIN, person(LIN, "林晓")],
	[ZHOU, person(ZHOU, "周野")],
	[XU, person(XU, "许诺")],
	[
		LIN_TWIN,
		{
			id: LIN_TWIN,
			tenantId: TENANT,
			kind: "agent",
			userId: null,
			ownerId: LIN,
			handle: "linxiao-twin",
			displayName: "林晓的分身",
			createdAt: AT,
		},
	],
]);

function joined(actorId: string, onBehalfOfId: string | null): Event {
	return {
		id: 1,
		tenantId: TENANT,
		conversationId: CONV,
		seq: 1,
		type: "member.joined",
		actorId,
		onBehalfOfId,
		payload: { principalId: ZHOU },
		createdAt: AT,
	};
}

describe("代理代办的系统行", () => {
	it("代理替本人拉人：写作“<代理>代<本人>”，本人看到的是“代你”", () => {
		const event = joined(LIN_TWIN, LIN);
		expect(describeEvent(event, map, XU)).toBe(
			"林晓的分身代林晓邀请周野加入了会话",
		);
		expect(describeEvent(event, map, LIN)).toBe(
			"林晓的分身代你邀请周野加入了会话",
		);
	});

	it("本人自己拉人照旧", () => {
		expect(describeEvent(joined(LIN, null), map, XU)).toBe(
			"林晓邀请周野加入了会话",
		);
	});
});

describe("消息的预览取纯文本", () => {
	function posted(text: string, format?: "text" | "md" | "html"): Event {
		return {
			id: 2,
			tenantId: TENANT,
			conversationId: CONV,
			seq: 2,
			type: "message.posted",
			actorId: LIN_TWIN,
			onBehalfOfId: LIN,
			payload: { text, mentions: [], ...(format ? { format } : {}) },
			createdAt: AT,
		};
	}

	it("md 去掉标记，取首行", () => {
		expect(previewOf(posted("## **排期**\n- 一", "md"), map, XU, true)).toBe(
			"林晓的分身：排期",
		);
	});

	it("html 取文本内容", () => {
		expect(
			previewOf(
				posted("<p>见<b>下表</b></p><p>二</p>", "html"),
				map,
				XU,
				false,
			),
		).toBe("见下表");
		expect(describeEvent(posted("<i>斜</i>", "html"), map, XU)).toBe("斜");
	});

	it("text 原样", () => {
		expect(previewOf(posted("**原样**"), map, XU, false)).toBe("**原样**");
	});
});
