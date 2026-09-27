"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "@/components/conversation/composer";
import { Inspector } from "@/components/conversation/inspector";
import { MessageList } from "@/components/conversation/message-list";
import { AgentActivityRows } from "@/components/conversation/working-indicator";
import { IconBack, IconPanel } from "@/components/icons";
import { Avatar, GroupAvatar } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { appHref } from "@/lib/auth-mode";
import { useMediaQuery, usePrincipalMap } from "@/lib/hooks";
import {
	agentRoleLine,
	conversationAvatar,
	conversationTitle,
	frontAgentIds,
	humanPair,
	STATUS_LABEL,
} from "@/lib/principals";
import {
	ensureEvents,
	loadEvents,
	markRead,
	refreshConversations,
	sendMessage,
	setActiveConversation,
	stopAgents,
	useStore,
} from "@/lib/store";

const WIDE = "(min-width: 1280px)";

export function ConversationView({
	conversationId,
}: {
	conversationId: string;
}) {
	const me = useStore((s) => s.me);
	const item = useStore((s) =>
		s.conversations.find((x) => x.conversation.id === conversationId),
	);
	const events = useStore((s) => s.events[conversationId]);
	const status = useStore((s) => s.eventsStatus[conversationId]);
	const directory = useStore((s) => s.directory);
	const activity = useStore((s) => s.activity[conversationId]);
	const map = usePrincipalMap();
	const wide = useMediaQuery(WIDE);
	const [panelWide, setPanelWide] = useState(false);
	const [panelDrawer, setPanelDrawer] = useState(false);
	const [missing, setMissing] = useState(false);
	const atBottom = useRef(false);

	// 打开会话时的已读位置：未读分隔线以此为准，之后不随已读上报移动。
	const [unreadAfter] = useState<number | null>(() =>
		item && item.unread > 0 ? (item.lastReadSeq ?? 0) : null,
	);

	useEffect(() => {
		if (item) {
			ensureEvents(conversationId);
			return;
		}
		// 刚被拉进来的会话可能还不在本地列表里：重拉一次，仍没有就是不存在或无权访问。
		let alive = true;
		void refreshConversations()
			.catch(() => {})
			.then(() => {
				if (alive) setMissing(true);
			});
		return () => {
			alive = false;
		};
	}, [item, conversationId]);

	const reportRead = useCallback(() => {
		const visible = document.visibilityState === "visible";
		const active = atBottom.current && visible;
		setActiveConversation(active ? conversationId : null);
		if (active) void markRead(conversationId).catch(() => {});
	}, [conversationId]);

	const onBottomChange = useCallback(
		(bottom: boolean) => {
			atBottom.current = bottom;
			reportRead();
		},
		[reportRead],
	);

	useEffect(() => {
		document.addEventListener("visibilitychange", reportRead);
		return () => {
			document.removeEventListener("visibilitychange", reportRead);
			setActiveConversation(null);
		};
	}, [reportRead]);

	const handles = useMemo(
		() => new Set(item?.members.map((m) => m.handle) ?? []),
		[item],
	);

	if (!me) return null;
	const meId = me.principal.id;

	if (!item) {
		return missing ? (
			<div className="flex flex-1 items-center justify-center">
				<EmptyState
					text="这个会话不存在，或者你不在其中。"
					action={{ label: "回到会话列表", href: appHref("/") }}
				/>
			</div>
		) : (
			<LoadingRows rows={4} />
		);
	}

	const peer = conversationAvatar(item, meId);
	const avatar = peer ? (map.get(peer.id) ?? peer) : null;
	const title = conversationTitle(item, meId);
	const kind = item.conversation.kind;
	const pair = humanPair(item, meId);
	const twinTarget =
		pair?.peerTwin && avatar ? { peer: avatar, peerTwin: pair.peerTwin } : null;
	const subtitle =
		kind === "group"
			? `${item.members.length} 位成员`
			: avatar?.kind === "agent"
				? agentRoleLine(avatar, map, meId, frontAgentIds(me, directory))
				: avatar
					? [
							`@${avatar.handle}`,
							avatar.status && avatar.status !== "available"
								? STATUS_LABEL[avatar.status]
								: null,
						]
							.filter(Boolean)
							.join(" · ")
					: "";
	const showPanel = wide ? panelWide : panelDrawer;
	const togglePanel = () =>
		wide ? setPanelWide((v) => !v) : setPanelDrawer((v) => !v);
	const closePanel = () => (wide ? setPanelWide(false) : setPanelDrawer(false));
	const emptyText =
		kind !== "dm"
			? "群里还没有人说话，打个招呼吧。"
			: avatar?.kind === "agent"
				? `和${avatar.displayName}说点什么吧，它会替你查资料、记事、分派活。`
				: `和${avatar?.displayName ?? "对方"}打个招呼吧。想让对方的分身先回答，就切到“问分身”。`;

	return (
		<div className="flex min-h-0 flex-1">
			<section className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
				<header className="flex h-header shrink-0 items-center gap-3 border-b border-line px-3 md:px-5">
					<Link
						href={appHref("/")}
						aria-label="返回会话列表"
						className="inline-flex size-8 items-center justify-center rounded-pill text-ink hover:bg-surface-2 md:hidden"
					>
						<IconBack />
					</Link>
					{avatar ? (
						<Avatar principal={avatar} size={28} showStatus />
					) : (
						<GroupAvatar id={item.conversation.id} title={title} size={28} />
					)}
					<div className="flex min-w-0 flex-1 flex-col">
						<h1 className="truncate text-16 font-semibold text-ink">{title}</h1>
						<p className="truncate text-12 text-muted">{subtitle}</p>
					</div>
					<IconButton
						label={showPanel ? "收起成员" : "查看成员"}
						active={showPanel}
						onClick={togglePanel}
					>
						<IconPanel />
					</IconButton>
				</header>
				{status === "error" ? (
					<ErrorState
						text="消息加载失败。"
						onRetry={() => void loadEvents(conversationId)}
					/>
				) : !events ? (
					<LoadingRows
						rows={5}
						className="mx-auto w-full max-w-thread flex-1"
					/>
				) : (
					<MessageList
						events={events}
						map={map}
						meId={meId}
						unreadAfter={unreadAfter}
						handles={handles}
						isGroup={kind !== "dm"}
						onBottomChange={onBottomChange}
						footer={
							<AgentActivityRows activity={activity} map={map} meId={meId} />
						}
						empty={
							<EmptyState
								mascotId={
									avatar?.kind === "agent" ? avatar.id : item.conversation.id
								}
								text={emptyText}
							/>
						}
					/>
				)}
				<Composer
					key={conversationId}
					members={item.members}
					meId={meId}
					map={map}
					placeholder={`发给 ${title}`}
					twinTarget={twinTarget}
					running={Boolean(activity)}
					onStop={() => stopAgents(conversationId)}
					onSend={(text, mentions, askTwin) =>
						sendMessage(conversationId, text, mentions, askTwin)
					}
				/>
			</section>
			{showPanel && wide ? (
				<aside className="w-inspector shrink-0 border-l border-line bg-bg">
					<Inspector item={item} map={map} meId={meId} onClose={closePanel} />
				</aside>
			) : null}
			{showPanel && !wide ? (
				<div className="fixed inset-0 z-20 flex justify-end">
					<button
						type="button"
						aria-label="关闭成员面板"
						className="flex-1 bg-scrim"
						onClick={closePanel}
					/>
					<aside className="h-full w-inspector max-w-full animate-pop-in bg-bg shadow-float">
						<Inspector item={item} map={map} meId={meId} onClose={closePanel} />
					</aside>
				</div>
			) : null}
		</div>
	);
}
