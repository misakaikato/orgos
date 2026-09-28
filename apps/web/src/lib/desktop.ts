"use client";

/**
 * 桌面客户端（apps/desktop）里的角标、系统通知与本机 Runner。页面在桌面壳里时 preload 暴露了
 * `window.orgosDesktop`：
 * - 未读总数交给 Dock 角标；窗口不在前台时，别人发来的新消息与新待办弹系统通知，
 *   点通知回到窗口并打开对应会话（由 store 在每次状态变化后调用）；
 * - 登录后读取本机 Runner 的身份，需要时用本人的登录身份生成一次性配对码，交给客户端把本机
 *   配对到当前账号（由 store 在会话就绪后调用）。
 * 普通浏览器里什么都不做。
 */
import type { OrgosDesktopApi, RunnerIdentity } from "@orgos/protocol";
import { previewOf } from "@/lib/describe";
import { buildPrincipalMap, conversationTitle, dmPeer } from "@/lib/principals";
import type { State } from "@/lib/store";

export function desktopBridge(): OrgosDesktopApi | undefined {
	return typeof window === "undefined" ? undefined : window.orgosDesktop;
}

declare global {
	interface Window {
		orgosDesktop?: OrgosDesktopApi;
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

function notify(bridge: OrgosDesktopApi, notice: DesktopNotice): void {
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
	const bridge = desktopBridge();
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

// ─────────────────────────── 本机 Runner ───────────────────────────

/** 本机需要（重新）配对的原因。 */
export type PairingNeed = "unpaired" | "other-server" | "not-mine";

/**
 * 本机 Runner 是否需要配对到当前账号：本机未配对；配对的服务器不是当前页面的源；
 * 配对的设备不在当前账号的设备列表里（例如换了账号登录）。不需要 → null。
 */
export function localRunnerPairingNeed(
	identity: Pick<RunnerIdentity, "paired" | "server" | "runnerId">,
	origin: string,
	myRunnerIds: readonly string[],
): PairingNeed | null {
	if (!identity.paired || !identity.runnerId) return "unpaired";
	if (identity.server !== origin) return "other-server";
	if (!myRunnerIds.includes(identity.runnerId)) return "not-mine";
	return null;
}

export type LocalRunnerDeps = {
	bridge: OrgosDesktopApi | undefined;
	/** 当前页面的源。 */
	origin: string;
	/** 当前账号的设备 id（GET /api/runners）。 */
	myRunnerIds: () => Promise<readonly string[]>;
	/** 用本人的登录身份生成一次性配对码（POST /api/runners/pairing-codes）。 */
	createPairingCode: () => Promise<string>;
};

function localRunnerId(
	identity: RunnerIdentity,
	origin: string,
): string | null {
	return identity.paired && identity.server === origin
		? identity.runnerId
		: null;
}

/**
 * 登录后把本机配对到当前账号（开启了"本机作为 Runner"且需要配对时），返回本机在当前服务器上的
 * 设备 id（设备页据此标出"本机"）；不在桌面客户端里 → null。
 * 配对码只在这一次调用里流转，不保存。
 */
export async function syncLocalRunner(
	deps: LocalRunnerDeps,
): Promise<string | null> {
	const { bridge, origin } = deps;
	if (!bridge?.runnerIdentity || !bridge.pairRunner) return null;
	const identity = await bridge.runnerIdentity();
	if (!identity.enabled) return localRunnerId(identity, origin);
	const need = localRunnerPairingNeed(
		identity,
		origin,
		await deps.myRunnerIds(),
	);
	if (need === null) return identity.runnerId;
	const result = await bridge.pairRunner(await deps.createPairingCode());
	if (!result.ok) throw new Error(result.message);
	return localRunnerId(await bridge.runnerIdentity(), origin);
}

let listeningRunnerEnabled = false;

/** "本机作为 Runner"被打开时回调（只登记一次）。 */
export function onLocalRunnerEnabled(fn: () => void): void {
	const bridge = desktopBridge();
	if (!bridge?.onRunnerEnabled || listeningRunnerEnabled) return;
	listeningRunnerEnabled = true;
	bridge.onRunnerEnabled(fn);
}
