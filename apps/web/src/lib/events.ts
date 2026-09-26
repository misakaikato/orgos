/**
 * 会话事件与会话摘要的纯函数（不依赖 React，便于单测）。
 */
import type { ConversationSummary, Event } from "@orgos/protocol";

/** 合并事件：按 seq 去重、升序。已有的同 seq 事件保留原对象。 */
export function mergeEvents(
	existing: readonly Event[],
	incoming: readonly Event[],
): Event[] {
	if (incoming.length === 0) return existing as Event[];
	const bySeq = new Map<number, Event>();
	for (const e of existing) if (e.seq !== null) bySeq.set(e.seq, e);
	let changed = false;
	for (const e of incoming) {
		if (e.seq === null || bySeq.has(e.seq)) continue;
		bySeq.set(e.seq, e);
		changed = true;
	}
	if (!changed) return existing as Event[];
	return [...bySeq.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export function maxSeq(list: readonly Event[]): number {
	return list.at(-1)?.seq ?? 0;
}

function activityOf(item: ConversationSummary): string {
	return item.lastEvent?.createdAt ?? item.conversation.createdAt;
}

export function sortByActivity(
	items: ConversationSummary[],
): ConversationSummary[] {
	return [...items].sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
}

/** 他人发来的消息才计未读。 */
export function countsAsUnread(event: Event, meId: string): boolean {
	return event.type === "message.posted" && event.actorId !== meId;
}

/**
 * 把一条新事件并入会话摘要列表。会话不在列表里时返回 null（调用方应重新拉取列表）。
 * `read` 为真表示该会话正被查看且已读，不累加未读。
 */
export function applyEventToSummaries(
	items: ConversationSummary[],
	event: Event,
	meId: string,
	read: boolean,
): ConversationSummary[] | null {
	const idx = items.findIndex(
		(x) => x.conversation.id === event.conversationId,
	);
	const current = items[idx];
	if (!current || event.seq === null) return null;
	if (event.seq <= (current.lastEvent?.seq ?? 0)) return items;
	const next: ConversationSummary = {
		...current,
		conversation: {
			...current.conversation,
			lastSeq: Math.max(current.conversation.lastSeq, event.seq),
		},
		lastEvent: event,
		unread: read ? 0 : current.unread + (countsAsUnread(event, meId) ? 1 : 0),
		lastReadSeq: read ? event.seq : current.lastReadSeq,
	};
	const copy = [...items];
	copy[idx] = next;
	return sortByActivity(copy);
}

/**
 * 用本地已上报的已读位置校正服务端返回的会话列表：列表请求可能早于已读上报发出，
 * 旧快照不能把已经读过的会话又标成未读。已加载事件的会话按事件精确重算未读数。
 */
export function reconcileRead(
	items: ConversationSummary[],
	reportedRead: Readonly<Record<string, number>>,
	events: Readonly<Record<string, readonly Event[]>>,
	meId: string,
): ConversationSummary[] {
	return items.map((item) => {
		const id = item.conversation.id;
		const local = reportedRead[id] ?? 0;
		if (local <= (item.lastReadSeq ?? 0)) return item;
		const loaded = events[id];
		const unread = loaded
			? loaded.filter((e) => (e.seq ?? 0) > local && countsAsUnread(e, meId))
					.length
			: local >= item.conversation.lastSeq
				? 0
				: item.unread;
		return { ...item, lastReadSeq: local, unread };
	});
}
