/**
 * 会话消息列的行模型：日期分隔、未读分隔、人的消息（5 分钟内同一人合并）、代理消息、事件行。
 */
import type { Event } from "@orgos/protocol";
import { sameDay } from "@/lib/format";
import type { PrincipalMap } from "@/lib/principals";

export const MERGE_WINDOW_MS = 5 * 60 * 1000;

export type MessageEvent = Extract<Event, { type: "message.posted" }>;

export type ThreadRow =
	| { kind: "day"; key: string; at: string }
	| { kind: "unread"; key: string }
	| { kind: "human"; key: string; event: MessageEvent; continued: boolean }
	| { kind: "agent"; key: string; event: MessageEvent; continued: boolean }
	| { kind: "line"; key: string; event: Event };

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
	let prev: Event | null = null;
	let unreadPlaced = unreadAfter === null;
	for (const event of events) {
		const key = String(event.seq ?? event.id);
		if (!prev || !sameDay(prev.createdAt, event.createdAt)) {
			rows.push({ kind: "day", key: `day-${key}`, at: event.createdAt });
			prev = null;
		}
		if (
			!unreadPlaced &&
			event.seq !== null &&
			event.seq > (unreadAfter ?? 0) &&
			event.type === "message.posted" &&
			event.actorId !== meId
		) {
			rows.push({ kind: "unread", key: "unread" });
			unreadPlaced = true;
			prev = null;
		}
		if (event.type === "message.posted") {
			const continued =
				prev?.type === "message.posted" &&
				prev.actorId === event.actorId &&
				Date.parse(event.createdAt) - Date.parse(prev.createdAt) <=
					MERGE_WINDOW_MS;
			const isAgent = map.get(event.actorId)?.kind === "agent";
			rows.push({ kind: isAgent ? "agent" : "human", key, event, continued });
		} else {
			rows.push({ kind: "line", key, event });
		}
		prev = event;
	}
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
