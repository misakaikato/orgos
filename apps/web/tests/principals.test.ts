import type { ConversationSummary, Principal } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import {
	avatarText,
	conversationFacet,
	conversationTitle,
	dmPeer,
	mascotTraits,
} from "@/lib/principals";

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

describe("avatarText", () => {
	it("中文名取最后两个字，拉丁名取首字母大写", () => {
		expect(avatarText("林晓")).toBe("林晓");
		expect(avatarText("欧阳娜娜")).toBe("娜娜");
		expect(avatarText("安")).toBe("安");
		expect(avatarText("alice")).toBe("A");
		expect(avatarText("Alice Wang")).toBe("AW");
		expect(avatarText("  ")).toBe("?");
	});
});

describe("mascotTraits", () => {
	it("同一 id 永远得到同一只团子，各维度落在取值范围内", () => {
		const ids = Array.from({ length: 200 }, (_, i) => `agent-${i}`);
		for (const id of ids) {
			const t = mascotTraits(id);
			expect(mascotTraits(id)).toEqual(t);
			expect(t.tone).toBeGreaterThanOrEqual(1);
			expect(t.tone).toBeLessThanOrEqual(8);
		}
		const all = ids.map(mascotTraits);
		expect(new Set(all.map((t) => t.tone)).size).toBe(8);
		expect(new Set(all.map((t) => t.shape)).size).toBe(4);
		expect(new Set(all.map((t) => t.eyes)).size).toBe(3);
		expect(new Set(all.map((t) => t.blush)).size).toBe(2);
	});
});

describe("conversationFacet", () => {
	const me = human(ME, "林晓");
	const xu = human(XU, "许诺");
	const chief = agent(CHIEF, ME, "林晓的幕僚长");

	it("同事找我的幕僚长：归入代理，标代理在对外", () => {
		expect(conversationFacet(dm([xu, chief, me]), ME)).toEqual({
			filter: "agents",
			tag: "代理在对外",
		});
	});

	it("我和自己的幕僚长：代理；我和同事：同事", () => {
		expect(conversationFacet(dm([me, chief]), ME)).toEqual({
			filter: "agents",
			tag: null,
		});
		expect(conversationFacet(dm([me, xu]), ME)).toEqual({
			filter: "colleagues",
			tag: null,
		});
	});

	it("协商会话：代理，标协商", () => {
		const item = dm([chief, agent(XU, XU, "许诺的幕僚长")]);
		item.conversation.kind = "negotiation";
		expect(conversationFacet(item, ME)).toEqual({
			filter: "agents",
			tag: "协商",
		});
	});
});
