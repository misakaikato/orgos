import type { Event } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import { negotiationView } from "@/lib/negotiation";

const TENANT = "44444444-4444-4444-8444-444444444444";
const NEGO = "11111111-1111-4111-8111-111111111111";
const A_TWIN = "22222222-2222-4222-8222-222222222222";
const B_TWIN = "33333333-3333-4333-8333-333333333333";
const ALICE = "55555555-5555-4555-8555-555555555555";
const BOB = "66666666-6666-4666-8666-666666666666";
const WORK = "77777777-7777-4777-8777-777777777777";

let seq = 0;
function ev(actorId: string, draft: Pick<Event, "type" | "payload">): Event {
	seq += 1;
	return {
		id: seq,
		tenantId: TENANT,
		conversationId: NEGO,
		seq,
		actorId,
		onBehalfOfId: null,
		createdAt: `2026-09-26T09:0${seq}:00.000Z`,
		...draft,
	} as Event;
}

describe("negotiationView", () => {
	it("还没有事件：刚开始", () => {
		expect(negotiationView([])).toMatchObject({
			steps: [],
			lastStatus: null,
			outcome: null,
			proposal: undefined,
		});
	});

	it("进行中：步数、最近一步的状态、最近一次提出的 proposal", () => {
		seq = 0;
		const view = negotiationView([
			ev(A_TWIN, {
				type: "negotiation.step",
				payload: {
					step: 1,
					status: "continue",
					message: "周二？",
					proposal: { slot: "周二" },
				},
			}),
			ev(B_TWIN, {
				type: "negotiation.step",
				payload: { step: 2, status: "need_owner", message: "问问本人" },
			}),
		]);
		expect(view.steps).toHaveLength(2);
		expect(view.lastStatus).toBe("need_owner");
		expect(view.outcome).toBeNull();
		expect(view.proposal).toEqual({ slot: "周二" });
	});

	it("结束：结果与最终 proposal；各人的确认按本人记录", () => {
		seq = 0;
		const final = { slot: "周三 15:30" };
		const view = negotiationView([
			ev(A_TWIN, {
				type: "negotiation.step",
				payload: { step: 1, status: "agree", message: "好", proposal: final },
			}),
			ev(A_TWIN, {
				type: "negotiation.ended",
				payload: { outcome: "agreed", proposal: final },
			}),
			ev(ALICE, {
				type: "confirmation.resolved",
				payload: { workItemId: WORK, action: "confirm" },
			}),
		]);
		expect(view.outcome).toBe("agreed");
		expect(view.proposal).toEqual(final);
		expect(view.confirmations.get(ALICE)).toBe("confirm");
		expect(view.confirmations.has(BOB)).toBe(false);
	});
});
