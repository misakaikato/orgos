import type { ConversationSummary, Principal } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import { conversationTitle, dmPeer } from "@/lib/principals";

const TENANT = "44444444-4444-4444-8444-444444444444";
const AT = "2026-09-26T09:00:00.000Z";

function human(id: string, displayName: string): Principal {
	return {
		id,
		tenantId: TENANT,
		kind: "human",
		userId: `u-${id}`,
		ownerId: null,
		handle: displayName.toLowerCase(),
		displayName,
		createdAt: AT,
	};
}

function agent(id: string, ownerId: string, displayName: string): Principal {
	return {
		id,
		tenantId: TENANT,
		kind: "agent",
		userId: null,
		ownerId,
		handle: `${id}-chief`,
		displayName,
		createdAt: AT,
	};
}

const ME = "11111111-1111-4111-8111-111111111111";
const XU = "22222222-2222-4222-8222-222222222222";
const CHIEF = "33333333-3333-4333-8333-333333333333";

function dm(members: Principal[]): ConversationSummary {
	return {
		conversation: {
			id: "55555555-5555-4555-8555-555555555555",
			tenantId: TENANT,
			kind: "dm",
			title: null,
			createdBy: XU,
			createdAt: AT,
			lastSeq: 0,
		},
		members,
		unread: 0,
	};
}

describe("dmPeer / conversationTitle", () => {
	const me = human(ME, "林晓");
	const xu = human(XU, "许诺");
	const chief = agent(CHIEF, ME, "林晓的幕僚长");

	it("别人找我幕僚长（我是 observer）：对方是来找我的人，与成员顺序无关", () => {
		for (const members of [
			[chief, xu, me],
			[xu, chief, me],
		]) {
			expect(dmPeer(dm(members), ME)?.id).toBe(XU);
			expect(conversationTitle(dm(members), ME)).toBe("许诺");
		}
	});

	it("我和自己的幕僚长私聊：对方是幕僚长", () => {
		expect(dmPeer(dm([me, chief]), ME)?.id).toBe(CHIEF);
	});

	it("来找幕僚长的人看到的对方是幕僚长，而不是 observer 本人", () => {
		for (const members of [
			[xu, chief, me],
			[xu, me, chief],
		]) {
			expect(conversationTitle(dm(members), XU)).toBe("林晓的幕僚长");
		}
	});

	it("两个人的私聊：对方就是那个人", () => {
		expect(dmPeer(dm([me, xu]), ME)?.id).toBe(XU);
	});
});
