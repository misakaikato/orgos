/**
 * 协商卡片的状态：由协商会话的事件推出（步数、最近一步、结果、各人的确认）。
 */
import type {
	Event,
	NEGOTIATION_OUTCOMES,
	NEGOTIATION_STATUSES,
} from "@orgos/protocol";
import type { StepEvent } from "@/lib/thread";

export type NegotiationView = {
	steps: StepEvent[];
	lastStatus: (typeof NEGOTIATION_STATUSES)[number] | null;
	outcome: (typeof NEGOTIATION_OUTCOMES)[number] | null;
	/** 结束时的 proposal；未结束时为最近一次提出的 proposal。 */
	proposal: unknown;
	/** 本人对结果的处理，键为本人 id。 */
	confirmations: ReadonlyMap<string, "confirm" | "reject">;
};

export function negotiationView(events: readonly Event[]): NegotiationView {
	const steps: StepEvent[] = [];
	let outcome: NegotiationView["outcome"] = null;
	let proposal: unknown;
	const confirmations = new Map<string, "confirm" | "reject">();
	for (const e of events) {
		switch (e.type) {
			case "negotiation.step":
				steps.push(e);
				if (e.payload.proposal !== undefined) proposal = e.payload.proposal;
				break;
			case "negotiation.ended":
				outcome = e.payload.outcome;
				if (e.payload.proposal !== undefined) proposal = e.payload.proposal;
				break;
			case "confirmation.resolved":
				confirmations.set(e.actorId, e.payload.action);
				break;
		}
	}
	return {
		steps,
		lastStatus: steps.at(-1)?.payload.status ?? null,
		outcome,
		proposal,
		confirmations,
	};
}
