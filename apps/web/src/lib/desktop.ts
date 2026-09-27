"use client";

/**
 * 桌面客户端（apps/desktop）里的角标与系统通知。页面在桌面壳里时 preload 暴露了
 * `window.orgosDesktop`：未读总数交给 Dock 角标；窗口不在前台时，别人发来的新消息与新待办
 * 弹系统通知，点通知回到窗口并打开对应会话。普通浏览器里什么都不做。
 * 由 store 在每次状态变化后调用。
 */
import { previewOf } from "@/lib/describe";
import { buildPrincipalMap, conversationTitle, dmPeer } from "@/lib/principals";
import type { State } from "@/lib/store";

type DesktopBridge = {
	setBadge(count: number): void;
	focus(): void;
};

declare global {
	interface Window {
		orgosDesktop?: DesktopBridge;
	}
}

export type DesktopNotice = {
	/** 同一件事只通知一次（也作系统通知的 tag）。 */
	key: string;
	title: string;
	body: string;
	/** 点通知后打开的页面。 */
	path: string;
};

export function unreadTotal(state: Pick<State, "conversations">): number {
	return state.conversations.reduce((n, x) => n + x.unread, 0);
}

/**
 * 两次状态之间新出现的、值得提醒本人的事：
 * - 别人发来的新消息；
 * - 我自己的代理在我与它的私聊里发给我的消息（例如助手办完事的回复）；
 *   它在别处代我发出的消息（分身替我回复别人）不算；
 * - 新的待办。
 */
export function desktopNotices(before: State, after: State): DesktopNotice[] {
	const meId = after.me?.principal.id;
	if (!meId || before.session !== "ready" || after.session !== "ready")
		return [];
	const notices: DesktopNotice[] = [];
	const previous = new Map(
		before.conversations.map((c) => [c.conversation.id, c]),
	);
	const map = buildPrincipalMap(
		after.me,
		after.directory,
		after.conversations,
		after.org,
	);
	for (const item of after.conversations) {
		const last = item.lastEvent;
		if (last?.type !== "message.posted" || last.actorId === meId) continue;
		const toMe =
			item.conversation.kind === "dm" &&
			dmPeer(item, meId)?.id === last.actorId;
		if (last.onBehalfOfId === meId && !toMe) continue;
		const id = item.conversation.id;
		const old = previous.get(id);
		const isNew = old
			? (last.seq ?? 0) > (old.lastEvent?.seq ?? 0)
			: item.unread > 0;
		if (!isNew) continue;
		const title = conversationTitle(item, meId);
		const speaker = map.get(last.actorId)?.displayName;
		notices.push({
			key: `message:${id}:${last.seq ?? last.id}`,
			title,
			body: previewOf(last, map, meId, speaker !== title),
			path: `/c/${id}`,
		});
	}
	if (before.workItems && after.workItems) {
		const known = new Set(before.workItems.map((w) => w.id));
		for (const w of after.workItems) {
			if (known.has(w.id)) continue;
			notices.push({
				key: `work-item:${w.id}`,
				title: `待办：${w.title}`,
				body: w.body,
				path: w.conversationId ? `/c/${w.conversationId}` : "/todo",
			});
		}
	}
	return notices;
}

let previousState: State | null = null;
let shownBadge = -1;

function notify(bridge: DesktopBridge, notice: DesktopNotice): void {
	if (typeof Notification === "undefined") return;
	if (Notification.permission === "denied") return;
	const n = new Notification(notice.title, {
		body: notice.body,
		tag: notice.key,
	});
	n.onclick = () => {
		bridge.focus();
		if (window.location.pathname !== notice.path)
			window.location.assign(notice.path);
	};
}

export function syncDesktop(state: State): void {
	const bridge =
		typeof window === "undefined" ? undefined : window.orgosDesktop;
	if (!bridge) return;
	const before = previousState;
	previousState = state;
	const badge = state.session === "ready" ? unreadTotal(state) : 0;
	if (badge !== shownBadge) {
		shownBadge = badge;
		bridge.setBadge(badge);
	}
	if (!before || before === state || document.hasFocus()) return;
	for (const notice of desktopNotices(before, state)) notify(bridge, notice);
}
