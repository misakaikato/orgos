"use client";

import type { ConversationSummary } from "@orgos/protocol";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { IconPlus } from "@/components/icons";
import { LogoutButton, NavTabs } from "@/components/nav-rail";
import { ThemeToggle } from "@/components/theme";
import { Avatar, GroupAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { type EmptyAction, EmptyState } from "@/components/ui/states";
import { appHref } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";
import { previewOf } from "@/lib/describe";
import { formatListTime } from "@/lib/format";
import { useOpenDm, usePrincipalMap } from "@/lib/hooks";
import {
	conversationTitle,
	dmPeer,
	groupConversations,
	type PrincipalMap,
} from "@/lib/principals";
import { useStore } from "@/lib/store";

function Section({
	title,
	count,
	children,
}: {
	title: string;
	count?: number;
	children: ReactNode;
}) {
	return (
		<section className="border-b border-line py-2 last:border-b-0">
			<h2 className="flex items-center justify-between px-4 py-1 text-12 font-medium text-muted">
				{title}
				{count ? <span className="font-code tabular-nums">{count}</span> : null}
			</h2>
			{children}
		</section>
	);
}

function ConversationRow({
	item,
	meId,
	map,
	active,
}: {
	item: ConversationSummary;
	meId: string;
	map: PrincipalMap;
	active: boolean;
}) {
	const peer = dmPeer(item, meId);
	const title = conversationTitle(item, meId);
	const time = item.lastEvent?.createdAt ?? item.conversation.createdAt;
	const preview = item.lastEvent
		? previewOf(item.lastEvent, map, meId, item.conversation.kind !== "dm")
		: "还没有消息";
	return (
		<Link
			href={appHref(`/c/${item.conversation.id}`)}
			aria-current={active ? "page" : undefined}
			className={cx(
				"mx-2 flex items-center gap-3 rounded-box px-2 py-2 transition-colors duration-150",
				active ? "bg-accent-soft" : "hover:bg-surface-2",
			)}
		>
			{peer ? <Avatar principal={peer} size="lg" /> : <GroupAvatar size="lg" />}
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex items-baseline gap-2">
					<span className="truncate text-14 font-medium text-ink">{title}</span>
					<span className="ml-auto shrink-0 font-code text-12 tabular-nums text-muted">
						{formatListTime(time)}
					</span>
				</span>
				<span className="flex items-center gap-2">
					<span className="truncate text-13 text-muted">{preview}</span>
					<Badge count={item.unread} className="ml-auto" />
				</span>
			</span>
		</Link>
	);
}

/** 列表栏：五个分组（DESIGN.md §5）。待我处理、代理在对外、协商在后续步骤接入数据。 */
export function ConversationList() {
	const pathname = usePathname();
	const me = useStore((s) => s.me);
	const conversations = useStore((s) => s.conversations);
	const connection = useStore((s) => s.connection);
	const map = usePrincipalMap();
	const { open, error } = useOpenDm();
	if (!me) return null;

	const meId = me.principal.id;
	const groups = groupConversations(conversations, meId);
	const chief = me.agents.find((a) => a.role === "front");
	const talkToChief: EmptyAction | undefined = chief
		? {
				label: `和${chief.principal.displayName}聊聊`,
				onClick: () => void open(chief.principal.id),
			}
		: undefined;
	const contacts: EmptyAction = {
		label: "打开通讯录",
		href: appHref("/contacts"),
	};
	const activeId = pathname.startsWith("/c/") ? pathname.slice(3) : null;
	const rows = (items: ConversationSummary[]) =>
		items.map((item) => (
			<ConversationRow
				key={item.conversation.id}
				item={item}
				meId={meId}
				map={map}
				active={item.conversation.id === activeId}
			/>
		));

	return (
		<>
			<div className="flex flex-col gap-3 border-b border-line px-4 py-3">
				<div className="flex items-center justify-between gap-2 lg:hidden">
					<NavTabs />
					<span className="flex items-center gap-1">
						<ThemeToggle />
						<LogoutButton />
					</span>
				</div>
				<div className="flex items-center justify-between gap-2">
					<h1 className="text-15 font-medium text-ink">会话</h1>
					<Link
						href={appHref("/new-group")}
						className="inline-flex h-8 items-center gap-1 rounded-capsule border border-line px-3 text-13 text-ink transition-colors duration-150 hover:bg-surface-2"
					>
						<IconPlus size={16} />
						新建群聊
					</Link>
				</div>
				{connection === "reconnecting" ? (
					<p role="status" className="font-code text-12 text-muted">
						连接中断，正在重连…
					</p>
				) : null}
				{error ? (
					<p role="alert" className="text-12 text-danger">
						{error}
					</p>
				) : null}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<Section title="待我处理">
					<EmptyState
						compact
						text="需要你拍板的事会出现在这里。"
						action={talkToChief}
					/>
				</Section>
				<Section title="我的代理组" count={groups.agents.length}>
					{groups.agents.length ? (
						rows(groups.agents)
					) : (
						<EmptyState
							compact
							text="还没有和你的代理组聊过。"
							action={talkToChief}
						/>
					)}
				</Section>
				<Section title="同事" count={groups.colleagues.length}>
					{groups.colleagues.length ? (
						rows(groups.colleagues)
					) : (
						<EmptyState compact text="还没有和同事聊过。" action={contacts} />
					)}
				</Section>
				<Section title="代理在对外">
					<EmptyState
						compact
						text="同事找你的幕僚长时，对话会出现在这里。"
						action={contacts}
					/>
				</Section>
				<Section title="协商" count={groups.negotiations.length}>
					{groups.negotiations.length ? (
						rows(groups.negotiations)
					) : (
						<EmptyState
							compact
							text="代理之间替你约事的协商会出现在这里。"
							action={talkToChief}
						/>
					)}
				</Section>
			</div>
		</>
	);
}
