/**
 * 会话消息列的行模型（DESIGN.md §4）：
 * - 时间分隔：第一条、跨天或与上一条间隔超过 10 分钟时插入；
 * - 未读分隔：打开会话时已读位置之后第一条他人消息前；
 * - 气泡：消息；同一发送者 3 分钟内连续的合并（只有第一条带头像与名字）；
 * - 代理动作不单独成行，折叠进该代理下一条气泡；没有下一条时在分隔前或末尾单列一行；
 * - 卡片：上报（带是否已答复）、审批（带结局）、协商（两人私聊里的 negotiation.started，过程在协商会话里）；
 * - 系统行：成员加入与退出、上报已答复、接了任务与任务结束、话题已转成群聊。
 * 任务的状态与进度在任务话题顶部的状态条上，不进消息列。
 * 协商的每一步、结果与确认属于协商会话本身，由协商卡片读取，不进消息列。
 */
import type { Event } from "@orgos/protocol";
import { sameDay } from "@/lib/format";
import type { PrincipalMap } from "@/lib/principals";

export const MERGE_WINDOW_MS = 3 * 60 * 1000;
export const STAMP_GAP_MS = 10 * 60 * 1000;

type EventOf<T extends Event["type"]> = Extract<Event, { type: T }>;
export type MessageEvent = EventOf<"message.posted">;
export type StepEvent = EventOf<"negotiation.step">;
export type ActionEvent = EventOf<"agent.action">;
export type EscalationEvent = EventOf<"escalation.created">;
export type EscalationResolvedEvent = EventOf<"escalation.resolved">;
export type NegotiationStartedEvent = EventOf<"negotiation.started">;
export type ApprovalEvent = EventOf<"approval.requested">;
export type ApprovalResolvedEvent = EventOf<"approval.resolved">;
export type SystemEvent = EventOf<
	| "member.joined"
	| "member.left"
	| "escalation.resolved"
	| "task.created"
	| "task.ended"
	| "topic.moved"
>;

/** 气泡的归属：我 / 其他人 / 代理。 */
export type BubbleSide = "me" | "human" | "agent";

export type ThreadRow =
	| { kind: "stamp"; key: string; at: string }
	| { kind: "unread"; key: string }
	| {
			kind: "bubble";
			key: string;
			event: MessageEvent;
			side: BubbleSide;
			/** 与上一条同一发送者合并（不再显示头像与名字）。 */
			continued: boolean;
			/** 折叠进这条气泡的代理动作（发生在它之前、尚未归属的）。 */
			actions: ActionEvent[];
	  }
	| { kind: "actions"; key: string; actorId: string; actions: ActionEvent[] }
	| {
			kind: "escalation";
			key: string;
			event: EscalationEvent;
			resolved: EscalationResolvedEvent | null;
	  }
	| {
			kind: "approval";
			key: string;
			event: ApprovalEvent;
			resolved: ApprovalResolvedEvent | null;
	  }
	| { kind: "negotiation"; key: string; event: NegotiationStartedEvent }
	| { kind: "system"; key: string; event: SystemEvent };

function keyOf(event: Event): string {
	return String(event.seq ?? `id-${event.id}`);
}

function sideOf(actorId: string, map: PrincipalMap, meId: string): BubbleSide {
	if (actorId === meId) return "me";
	return map.get(actorId)?.kind === "agent" ? "agent" : "human";
}

/**
 * @param unreadAfter 打开会话时的已读位置；其后第一条他人消息前插入未读分隔（null 不插）。
 */
export function buildThreadRows(
	events: readonly Event[],
	map: PrincipalMap,
	meId: string,
	unreadAfter: number | null,
): ThreadRow[] {
	const rows: ThreadRow[] = [];
	const resolvedBy = new Map<string, EscalationResolvedEvent>();
	const approvedBy = new Map<string, ApprovalResolvedEvent>();
	for (const e of events) {
		if (e.type === "escalation.resolved")
			resolvedBy.set(e.payload.workItemId, e);
		if (e.type === "approval.resolved") approvedBy.set(e.payload.workItemId, e);
	}

	/** 各代理尚未归属到气泡的动作，按首次出现排序。 */
	const pending = new Map<string, ActionEvent[]>();
	const flushActions = () => {
		for (const [actorId, actions] of pending) {
			const first = actions[0];
			if (first)
				rows.push({
					kind: "actions",
					key: `actions-${keyOf(first)}`,
					actorId,
					actions,
				});
		}
		pending.clear();
	};

	let prevAt: string | null = null;
	/** 上一个气泡（用于合并）；任何分隔、卡片、系统行都会打断合并。 */
	let lastBubble: { actorId: string; at: string } | null = null;
	let unreadPlaced = unreadAfter === null;

	for (const event of events) {
		const key = keyOf(event);
		const gap =
			prevAt === null ||
			!sameDay(prevAt, event.createdAt) ||
			Date.parse(event.createdAt) - Date.parse(prevAt) > STAMP_GAP_MS;
		if (gap) {
			flushActions();
			rows.push({ kind: "stamp", key: `stamp-${key}`, at: event.createdAt });
			lastBubble = null;
		}
		prevAt = event.createdAt;

		if (
			!unreadPlaced &&
			event.seq !== null &&
			event.seq > (unreadAfter ?? 0) &&
			event.type === "message.posted" &&
			event.actorId !== meId
		) {
			rows.push({ kind: "unread", key: "unread" });
			unreadPlaced = true;
			lastBubble = null;
		}

		switch (event.type) {
			case "agent.action": {
				const list = pending.get(event.actorId) ?? [];
				list.push(event);
				pending.set(event.actorId, list);
				break;
			}
			case "message.posted": {
				const continued =
					lastBubble !== null &&
					lastBubble.actorId === event.actorId &&
					Date.parse(event.createdAt) - Date.parse(lastBubble.at) <=
						MERGE_WINDOW_MS;
				const actions = pending.get(event.actorId) ?? [];
				pending.delete(event.actorId);
				rows.push({
					kind: "bubble",
					key,
					event,
					side: sideOf(event.actorId, map, meId),
					continued,
					actions,
				});
				lastBubble = { actorId: event.actorId, at: event.createdAt };
				break;
			}
			case "escalation.created":
				rows.push({
					kind: "escalation",
					key,
					event,
					resolved: resolvedBy.get(event.payload.workItemId) ?? null,
				});
				lastBubble = null;
				break;
			case "approval.requested":
				rows.push({
					kind: "approval",
					key,
					event,
					resolved: approvedBy.get(event.payload.workItemId) ?? null,
				});
				lastBubble = null;
				break;
			case "negotiation.started":
				rows.push({ kind: "negotiation", key, event });
				lastBubble = null;
				break;
			case "member.joined":
			case "member.left":
			case "escalation.resolved":
			case "task.created":
			case "task.ended":
			case "topic.moved":
				rows.push({ kind: "system", key, event });
				lastBubble = null;
				break;
			case "negotiation.step":
			case "negotiation.ended":
			case "confirmation.resolved":
			case "approval.resolved":
			case "task.updated":
				break;
		}
	}
	flushActions();
	return rows;
}

/** 文本里的 @handle 片段（用于高亮与提取提及）。 */
const MENTION_RE = /@([a-z][a-z0-9-]{1,40})/g;

export type TextPart = { text: string; mention: boolean };

export function splitMentions(
	text: string,
	handles: ReadonlySet<string>,
): TextPart[] {
	const parts: TextPart[] = [];
	let last = 0;
	for (const m of text.matchAll(MENTION_RE)) {
		const handle = m[1] ?? "";
		if (!handles.has(handle)) continue;
		const start = m.index ?? 0;
		if (start > last)
			parts.push({ text: text.slice(last, start), mention: false });
		parts.push({ text: m[0], mention: true });
		last = start + m[0].length;
	}
	if (last < text.length)
		parts.push({ text: text.slice(last), mention: false });
	return parts;
}

/** 从正文中找出被 @ 的成员 id（handle 后必须是边界）。 */
export function extractMentions(
	text: string,
	members: readonly { id: string; handle: string }[],
	excludeId: string,
): string[] {
	const found = new Set<string>();
	for (const m of text.matchAll(MENTION_RE)) {
		const member = members.find((x) => x.handle === m[1]);
		if (member && member.id !== excludeId) found.add(member.id);
	}
	return [...found];
}
