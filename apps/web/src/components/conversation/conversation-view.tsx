"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "@/components/conversation/composer";
import { Inspector } from "@/components/conversation/inspector";
import { ExternalTag } from "@/components/conversation/message-item";
import { MessageList } from "@/components/conversation/message-list";
import { NewTaskToggle } from "@/components/conversation/task-bar";
import { TaskStatusBar } from "@/components/conversation/task-status";
import { TopicPicker, TopicRail } from "@/components/conversation/topic-bar";
import {
	TopicHeader,
	TopicSource,
} from "@/components/conversation/topic-header";
import { AgentActivityRows } from "@/components/conversation/working-indicator";
import { IconBack, IconPanel } from "@/components/icons";
import { Avatar, GroupAvatar } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { activityIn } from "@/lib/activity";
import { appHref } from "@/lib/auth-mode";
import {
	useExternalAgentIds,
	useMediaQuery,
	usePrincipalMap,
} from "@/lib/hooks";
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
	ensureTopics,
	loadEvents,
	loadTopics,
	markRead,
	markTopicSeen,
	refreshConversations,
	sendMessage,
	setActiveConversation,
	startNewTask,
	stopAgents,
	useStore,
} from "@/lib/store";
import { eventsOfTopic, topicHasUnread, visibleTopics } from "@/lib/topics";

const WIDE = "(min-width: 1280px)";
/** 视口够宽时话题栏是消息区左侧的窄栏，否则收成头部下方的下拉。 */
const TOPIC_RAIL = "(min-width: 1024px)";

export function ConversationView({
	conversationId,
	topicId,
}: {
	conversationId: string;
	/** 地址栏里选中的话题；缺省为主线。 */
	topicId?: string;
}) {
	const router = useRouter();
	const me = useStore((s) => s.me);
	const item = useStore((s) =>
		s.conversations.find((x) => x.conversation.id === conversationId),
	);
	const topics = useStore((s) => s.topics[conversationId]);
	const topicsStatus = useStore((s) => s.topicsStatus[conversationId]);
	const allEvents = useStore((s) => s.events[conversationId]);
	const topicSeen = useStore((s) => s.topicSeen);
	const directory = useStore((s) => s.directory);
	const agentsAt = useStore((s) => s.activity[conversationId]);
	const map = usePrincipalMap();
	const wide = useMediaQuery(WIDE);
	const railed = useMediaQuery(TOPIC_RAIL);
	const [panelWide, setPanelWide] = useState(false);
	const [panelDrawer, setPanelDrawer] = useState(false);
	const [missing, setMissing] = useState(false);
	const [newTask, setNewTask] = useState(false);
	const externalIds = useExternalAgentIds();
	const atBottom = useRef(false);

	// 打开会话时的已读位置：未读分隔线与话题栏的未读点以此为准，之后不随已读上报移动。
	const [openedAt] = useState(() => item?.lastReadSeq ?? 0);
	const [unreadAfter] = useState<number | null>(() =>
		item && item.unread > 0 ? (item.lastReadSeq ?? 0) : null,
	);

	const shown = useMemo(() => visibleTopics(topics ?? []), [topics]);
	const topic =
		(topics ?? []).find((t) => t.id === topicId) ??
		shown.find((t) => t.isMain) ??
		null;
	const activeTopicId = topic?.id ?? null;
	const status = useStore((s) =>
		activeTopicId ? s.eventsStatus[activeTopicId] : undefined,
	);
	const events = useMemo(
		() => (topic && allEvents ? eventsOfTopic(allEvents, topic) : undefined),
		[allEvents, topic],
	);
	const activity = useMemo(
		() => (topic ? activityIn(agentsAt, topic.id, topic.isMain) : []),
		[agentsAt, topic],
	);
	const unreadTopics = useMemo(() => {
		const meId = me?.principal.id ?? "";
		return new Set(
			shown
				.filter((t) =>
					topicHasUnread(
						allEvents,
						t,
						topicSeen[t.id] ?? openedAt,
						meId,
						t.id in topicSeen,
					),
				)
				.map((t) => t.id),
		);
	}, [shown, allEvents, topicSeen, openedAt, me]);

	const selectTopic = useCallback(
		(id: string) => {
			const target = (topics ?? []).find((t) => t.id === id);
			router.replace(
				appHref(
					target?.isMain
						? `/c/${conversationId}`
						: `/c/${conversationId}?t=${id}`,
				),
			);
		},
		[router, topics, conversationId],
	);

	useEffect(() => {
		if (item) {
			ensureTopics(conversationId);
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

	useEffect(() => {
		if (activeTopicId) ensureEvents(conversationId, activeTopicId);
	}, [conversationId, activeTopicId]);

	const reportRead = useCallback(() => {
		const visible = document.visibilityState === "visible";
		const active = atBottom.current && visible;
		setActiveConversation(active ? conversationId : null);
		if (!active) return;
		void markRead(conversationId).catch(() => {});
		const seen = events?.at(-1)?.seq;
		if (activeTopicId && seen) markTopicSeen(activeTopicId, seen);
	}, [conversationId, activeTopicId, events]);

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
			? `${item.members.filter((m) => m.kind === "human").length} 位成员`
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
	const external = avatar?.kind === "agent" && externalIds.has(avatar.id);
	const ownAgent = avatar?.kind === "agent" && avatar.ownerId === meId;
	const showPanel = wide ? panelWide : panelDrawer;
	const togglePanel = () =>
		wide ? setPanelWide((v) => !v) : setPanelDrawer((v) => !v);
	const closePanel = () => (wide ? setPanelWide(false) : setPanelDrawer(false));
	const emptyText =
		kind !== "dm"
			? "群里还没有人说话，打个招呼吧。"
			: external
				? `把一件事交给${avatar?.displayName ?? "它"}吧：它在你的设备上干活，写文件和执行命令前会先问你。`
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
						<h1 className="flex min-w-0 items-center gap-2">
							<span className="truncate text-16 font-semibold text-ink">
								{title}
							</span>
							{avatar?.kind === "agent" ? <ExternalTag id={avatar.id} /> : null}
						</h1>
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
				<div className="flex min-h-0 flex-1">
					{railed && topic ? (
						<TopicRail
							conversationId={conversationId}
							topics={shown}
							activeId={topic.id}
							unread={unreadTopics}
							onSelect={selectTopic}
						/>
					) : null}
					<div className="flex min-h-0 min-w-0 flex-1 flex-col">
						{!railed && topic ? (
							<TopicPicker
								conversationId={conversationId}
								topics={shown}
								activeId={topic.id}
								unread={unreadTopics}
								onSelect={selectTopic}
							/>
						) : null}
						{topic ? (
							<TopicHeader
								key={`header-${topic.id}`}
								conversationId={conversationId}
								topic={topic}
								canTask={ownAgent}
							/>
						) : null}
						{topic?.kind === "task" && topic.taskId ? (
							<TaskStatusBar taskId={topic.taskId} map={map} meId={meId} />
						) : null}
						{topicsStatus === "error" || status === "error" ? (
							<ErrorState
								text="消息加载失败。"
								onRetry={() =>
									void (topic
										? loadEvents(conversationId, topic.id)
										: loadTopics(conversationId))
								}
							/>
						) : !events || !topic ? (
							<LoadingRows
								rows={5}
								className="mx-auto w-full max-w-thread flex-1"
							/>
						) : (
							<MessageList
								key={`list-${topic.id}`}
								events={events}
								map={map}
								meId={meId}
								unreadAfter={unreadAfter}
								handles={handles}
								isGroup={kind !== "dm"}
								onBottomChange={onBottomChange}
								header={
									topic.sourceTopicId ? (
										<TopicSource topicId={topic.id} map={map} meId={meId} />
									) : null
								}
								footer={
									<AgentActivityRows
										activity={activity}
										map={map}
										meId={meId}
									/>
								}
								empty={
									<EmptyState
										mascotId={
											avatar?.kind === "agent"
												? avatar.id
												: item.conversation.id
										}
										text={topic.isMain ? emptyText : "这个话题还没有消息。"}
									/>
								}
							/>
						)}
						{topic ? (
							<Composer
								key={`composer-${topic.id}`}
								members={item.members}
								meId={meId}
								map={map}
								placeholder={
									newTask
										? `交给 ${title} 一个新任务`
										: topic.isMain
											? `发给 ${title}`
											: `在“${topic.title}”里说`
								}
								twinTarget={twinTarget}
								isGroup={kind === "group"}
								running={activity.length > 0}
								onStop={() => stopAgents(conversationId, topic.id)}
								banner={
									ownAgent ? (
										<NewTaskToggle
											on={newTask}
											onToggle={() => setNewTask((v) => !v)}
										/>
									) : null
								}
								onSend={async (text, mentions, askTwin) => {
									if (newTask) {
										const id = await startNewTask(conversationId, text);
										setNewTask(false);
										if (id) selectTopic(id);
										return;
									}
									await sendMessage(
										conversationId,
										topic.id,
										text,
										mentions,
										askTwin,
									);
								}}
							/>
						) : null}
					</div>
				</div>
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
