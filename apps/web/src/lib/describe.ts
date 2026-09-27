/**
 * 事件的一行文字描述（会话里的系统行、卡片副标题与列表预览共用）。
 */
import type { Event, NEGOTIATION_OUTCOMES } from "@orgos/protocol";
import { onBehalfLabel, type PrincipalMap } from "@/lib/principals";

type NegotiationOutcome = (typeof NEGOTIATION_OUTCOMES)[number];

export const OUTCOME_LABEL: Record<NegotiationOutcome, string> = {
	agreed: "已谈妥，等双方本人确认",
	rejected: "未谈成",
	exhausted: "步数用尽，未谈成",
};

export function nameOf(id: string, map: PrincipalMap, meId: string): string {
	if (id === meId) return "你";
	return map.get(id)?.displayName ?? "某人";
}

export function describeEvent(
	event: Event,
	map: PrincipalMap,
	meId: string,
): string {
	const actor = nameOf(event.actorId, map, meId);
	switch (event.type) {
		case "message.posted":
			return event.payload.text;
		case "member.joined": {
			const who = nameOf(event.payload.principalId, map, meId);
			return event.payload.principalId === event.actorId
				? `${who}加入了会话`
				: `${actor}邀请${who}加入了会话`;
		}
		case "agent.action":
			return `${actor}${event.payload.summary}`;
		case "escalation.created": {
			const agent = map.get(event.actorId);
			const owner = agent ? onBehalfLabel(agent, map, meId) : null;
			const to = owner === "你" ? "你" : `${owner ?? ""}本人`;
			return `${actor}已转给${to}：${event.payload.question}`;
		}
		case "escalation.resolved":
			return `${actor}已答复转来的问题`;
		case "negotiation.started":
			return `两位的分身开始协商：${event.payload.goal}`;
		case "negotiation.step":
			return `协商第 ${event.payload.step} 步：${event.payload.message}`;
		case "negotiation.ended":
			return `协商结束：${OUTCOME_LABEL[event.payload.outcome]}`;
		case "confirmation.resolved":
			return `${actor}${event.payload.action === "confirm" ? "确认了" : "驳回了"}协商结果`;
	}
}

/** 列表预览：消息取首行，群聊带说话人；其他事件用描述。 */
export function previewOf(
	event: Event,
	map: PrincipalMap,
	meId: string,
	withSpeaker: boolean,
): string {
	if (event.type !== "message.posted") return describeEvent(event, map, meId);
	const firstLine = event.payload.text.split("\n", 1)[0] ?? "";
	if (event.actorId === meId) return `你：${firstLine}`;
	return withSpeaker
		? `${nameOf(event.actorId, map, meId)}：${firstLine}`
		: firstLine;
}
