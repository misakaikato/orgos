import type { ConversationSummary, Principal } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import {
	avatarText,
	conversationFilter,
	conversationTitle,
	dmPeer,
	humanPair,
	MASCOT_ART_COUNT,
	mascotArt,
	mascotArtAt,
	unavailableHint,
} from "@/lib/principals";

const TENANT = "44444444-4444-4444-8444-444444444444";
const AT = "2026-09-26T09:00:00.000Z";

function human(
	id: string,
	displayName: string,
	status: Principal["status"] = "available",
): Principal {
	return {
		id,
		tenantId: TENANT,
		kind: "human",
		userId: `u-${id}`,
		ownerId: null,
		handle: displayName.toLowerCase(),
		displayName,
		createdAt: AT,
		status,
	};
}

function agent(id: string, ownerId: string, displayName: string): Principal {
	return {
		id,
		tenantId: TENANT,
		kind: "agent",
		userId: null,
		ownerId,
		handle: `${id}-twin`,
		displayName,
		createdAt: AT,
	};
}

const ME = "11111111-1111-4111-8111-111111111111";
const XU = "22222222-2222-4222-8222-222222222222";
const MY_TWIN = "33333333-3333-4333-8333-333333333333";
const XU_TWIN = "66666666-6666-4666-8666-666666666666";

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

describe("dmPeer / conversationTitle / humanPair", () => {
	const me = human(ME, "林晓");
	const xu = human(XU, "许诺");
	const myTwin = agent(MY_TWIN, ME, "林晓的分身");
	const xuTwin = agent(XU_TWIN, XU, "许诺的分身");

	it("真人私聊：标题与对方都是对方本人，分身不占标题，与成员顺序无关", () => {
		for (const members of [
			[myTwin, xuTwin, xu, me],
			[me, xu, myTwin, xuTwin],
			[xuTwin, me, myTwin, xu],
		]) {
			expect(dmPeer(dm(members), ME)?.id).toBe(XU);
			expect(conversationTitle(dm(members), ME)).toBe("许诺");
			expect(conversationTitle(dm(members), XU)).toBe("林晓");
			expect(humanPair(dm(members), ME)).toEqual({
				peer: xu,
				peerTwin: xuTwin,
				myTwin,
			});
		}
	});

	it("我和自己的分身私聊：对方是分身，不是真人私聊", () => {
		expect(dmPeer(dm([me, myTwin]), ME)?.id).toBe(MY_TWIN);
		expect(conversationTitle(dm([me, myTwin]), ME)).toBe("林晓的分身");
		expect(humanPair(dm([me, myTwin]), ME)).toBeNull();
	});

	it("群聊不是真人私聊", () => {
		const item = dm([me, xu, myTwin, xuTwin]);
		item.conversation.kind = "group";
		expect(humanPair(item, ME)).toBeNull();
		expect(dmPeer(item, ME)).toBeNull();
	});
});

describe("unavailableHint", () => {
	it("对方忙碌或离开时提示分身会先回复；在线时没有提示", () => {
		expect(unavailableHint(human(XU, "周野", "busy"))).toBe(
			"周野正在忙，分身会先回复你",
		);
		expect(unavailableHint(human(XU, "周野", "away"))).toBe(
			"周野暂时离开，分身会先回复你",
		);
		expect(unavailableHint(human(XU, "周野"))).toBeNull();
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

describe("mascotArt", () => {
	const ids = Array.from({ length: 200 }, (_, i) => `agent-${i}`);

	it("同一 id 永远得到同一张插画", () => {
		for (const id of ids) expect(mascotArt(id)).toEqual(mascotArt(id));
		expect(mascotArt(MY_TWIN)).toEqual(mascotArt(MY_TWIN));
	});

	it("200 个 id 覆盖全部 12 张插画", () => {
		expect(MASCOT_ART_COUNT).toBe(12);
		expect(new Set(ids.map((id) => mascotArt(id).index)).size).toBe(12);
	});

	it("插画与名字色一一对应，且与 mascotArt 的结果一致", () => {
		const tones = Array.from({ length: 12 }, (_, i) => mascotArtAt(i + 1).tone);
		expect(tones).toEqual([1, 2, 3, 5, 6, 7, 4, 8, 1, 2, 4, 5]);
		expect(mascotArtAt(1).src).toBe("/mascots/m01.png");
		expect(mascotArtAt(12).src).toBe("/mascots/m12.png");
		for (const id of ids) {
			const art = mascotArt(id);
			expect(art).toEqual(mascotArtAt(art.index));
		}
	});
});

describe("conversationFilter", () => {
	const me = human(ME, "林晓");
	const xu = human(XU, "许诺");
	const myTwin = agent(MY_TWIN, ME, "林晓的分身");
	const xuTwin = agent(XU_TWIN, XU, "许诺的分身");

	it("真人私聊（含双方分身）归同事；和自己的分身归代理", () => {
		expect(conversationFilter(dm([me, xu, myTwin, xuTwin]), ME)).toBe(
			"colleagues",
		);
		expect(conversationFilter(dm([me, myTwin]), ME)).toBe("agents");
	});

	it("群聊：只有代理归代理，有同事归同事", () => {
		const onlyAgents = dm([me, myTwin, xuTwin]);
		onlyAgents.conversation.kind = "group";
		expect(conversationFilter(onlyAgents, ME)).toBe("agents");
		const mixed = dm([me, xu, myTwin]);
		mixed.conversation.kind = "group";
		expect(conversationFilter(mixed, ME)).toBe("colleagues");
	});
});
