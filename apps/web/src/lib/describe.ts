/**
 * 事件的一行文字描述（会话里的系统行、卡片副标题与列表预览共用）。
 */
import {
	type Event,
	type NEGOTIATION_OUTCOMES,
	previewTextOf,
	type TaskState,
} from "@orgos/protocol";
import { APPROVAL_OUTCOME_LABEL, capabilityLabel } from "@/lib/device";
import { onBehalfLabel, type PrincipalMap } from "@/lib/principals";

type NegotiationOutcome = (typeof NEGOTIATION_OUTCOMES)[number];

export const OUTCOME_LABEL: Record<NegotiationOutcome, string> = {
	agreed: "已谈妥，等双方本人确认",
	rejected: "未谈成",
	exhausted: "步数用尽，未谈成",
};

/** 任务状态在界面上的说法（状态胶囊、系统描述共用）。 */
export const TASK_STATE_LABEL: Record<TaskState, string> = {
	submitted: "已交办",
	working: "进行中",
	input_required: "等你回复",
	awaiting_approval: "等你批准",
	completed: "已完成",
	failed: "失败",
	canceled: "已停止",
};

export function nameOf(id: string, map: PrincipalMap, meId: string): string {
	if (id === meId) return "你";
	return map.get(id)?.displayName ?? "某人";
}

/** 本人才会做的动作（拉人、移人、转群）的做事者：代理替本人做的写作"林晓的分身代林晓"。 */
function doerOf(event: Event, map: PrincipalMap, meId: string): string {
	const actor = nameOf(event.actorId, map, meId);
	if (!event.onBehalfOfId || map.get(event.actorId)?.kind !== "agent")
		return actor;
	const owner = onBehalfLabel({ ownerId: event.onBehalfOfId }, map, meId);
	return owner ? `${actor}代${owner}` : actor;
}

export function describeEvent(
	event: Event,
	map: PrincipalMap,
	meId: string,
): string {
	const actor = nameOf(event.actorId, map, meId);
	switch (event.type) {
		case "message.posted":
			return previewTextOf(event.payload);
		case "member.joined": {
			const who = nameOf(event.payload.principalId, map, meId);
			return event.payload.principalId === event.actorId
				? `${who}加入了会话`
				: `${doerOf(event, map, meId)}邀请${who}加入了会话`;
		}
		case "member.left": {
			const who = nameOf(event.payload.principalId, map, meId);
			return event.payload.principalId === event.actorId
				? `${who}退出了群聊`
				: `${doerOf(event, map, meId)}把${who}移出了群聊`;
		}
		case "topic.moved":
			return `${doerOf(event, map, meId)}把这个话题转成了群聊“${event.payload.title}”`;
		case "agent.action":
			return `${actor}${event.payload.summary}`;
		case "escalation.created": {
			const agent = map.get(event.actorId);
			const owner = agent ? onBehalfLabel(agent, map, meId) : null;
			const to = owner === "你" ? "你" : `${owner ?? ""}本人`;
			return `${actor}已转给${to}：${event.payload.question}`;
		}
		case "escalation.resolved":
			return event.payload.action === "decline"
				? `${actor}暂不答复转来的问题`
				: `${actor}已答复转来的问题`;
		case "negotiation.started":
			return `两位的分身开始协商：${event.payload.goal}`;
		case "negotiation.step":
			return `协商第 ${event.payload.step} 步：${event.payload.message}`;
		case "negotiation.ended":
			return `协商结束：${OUTCOME_LABEL[event.payload.outcome]}`;
		case "confirmation.resolved":
			return `${actor}${event.payload.action === "confirm" ? "确认了" : "驳回了"}协商结果`;
		case "approval.requested":
			return `${actor}请求在“${event.payload.runnerName}”上${capabilityLabel(event.payload.capability)}`;
		case "approval.resolved":
			return `审批${APPROVAL_OUTCOME_LABEL[event.payload.outcome]}`;
		case "task.created":
			return `${actor}接了任务：${event.payload.title}`;
		case "task.updated":
			return `任务${TASK_STATE_LABEL[event.payload.state]}`;
		case "task.ended":
			return `任务${TASK_STATE_LABEL[event.payload.state]}${event.payload.summary ? `：${event.payload.summary}` : ""}`;
	}
}

/** 列表预览：消息取纯文本的首行，群聊带说话人；其他事件用描述。 */
export function previewOf(
	event: Event,
	map: PrincipalMap,
	meId: string,
	withSpeaker: boolean,
): string {
	if (event.type !== "message.posted") return describeEvent(event, map, meId);
	const firstLine = previewTextOf(event.payload).split("\n", 1)[0] ?? "";
	if (event.actorId === meId) return `你：${firstLine}`;
	return withSpeaker
		? `${nameOf(event.actorId, map, meId)}：${firstLine}`
		: firstLine;
}
