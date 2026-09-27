"use client";

import type { ConversationSummary } from "@orgos/protocol";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { IconPlus, IconSearch } from "@/components/icons";
import { Avatar, GroupAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { type EmptyAction, EmptyState } from "@/components/ui/states";
import { appHref } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";
import { previewOf } from "@/lib/describe";
import { formatListTime } from "@/lib/format";
import { useOpenDm, usePrincipalMap } from "@/lib/hooks";
import {
	conversationAvatar,
	conversationFilter,
	conversationTitle,
	type ListFilter,
	type PrincipalMap,
} from "@/lib/principals";
import { useStore } from "@/lib/store";

const FILTERS: { key: ListFilter; label: string }[] = [
	{ key: "all", label: "全部" },
	{ key: "agents", label: "代理" },
	{ key: "colleagues", label: "同事" },
];

type Row = {
	item: ConversationSummary;
	title: string;
	preview: string;
	filter: Exclude<ListFilter, "all">;
	pending: number;
};

function ConversationRow({
	row,
	map,
	meId,
	active,
}: {
	row: Row;
	map: PrincipalMap;
	meId: string;
	active: boolean;
}) {
	const { item, title, preview, pending } = row;
	const peer = conversationAvatar(item, meId);
	const avatar = peer ? (map.get(peer.id) ?? peer) : null;
	const time = item.lastEvent?.createdAt ?? item.conversation.createdAt;
	return (
		<Link
			href={appHref(`/c/${item.conversation.id}`)}
			aria-current={active ? "page" : undefined}
			className={cx(
				"group mx-2 flex h-row items-center gap-3 rounded-row px-2 transition-colors duration-150",
				active ? "bg-accent-soft" : "hover:bg-surface-2",
			)}
		>
			{avatar ? (
				<Avatar
					principal={avatar}
					size={40}
					showStatus
					ring={active ? "accent-soft" : "list-row"}
				/>
			) : (
				<GroupAvatar id={item.conversation.id} title={title} size={40} />
			)}
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex items-center gap-2">
					<span className="truncate text-14 font-semibold text-ink">
						{title}
					</span>
					<span className="ml-auto shrink-0 text-12 text-muted">
						{formatListTime(time)}
					</span>
				</span>
				<span className="flex items-center gap-2">
					<span className="min-w-0 flex-1 truncate text-13 text-muted">
						{preview}
					</span>
					<Badge count={pending} tone="pending" label={`${pending} 条待办`} />
					<Badge count={item.unread} />
				</span>
			</span>
		</Link>
	);
}

function toRows(
	items: readonly ConversationSummary[],
	map: PrincipalMap,
	meId: string,
	pendingBy: ReadonlyMap<string, number>,
): Row[] {
	return items.map((item) => ({
		item,
		title: conversationTitle(item, meId),
		preview: item.lastEvent
			? previewOf(item.lastEvent, map, meId, item.conversation.kind !== "dm")
			: "还没有消息",
		filter: conversationFilter(item, meId),
		pending: pendingBy.get(item.conversation.id) ?? 0,
	}));
}

/** 会话列表栏：搜索 + 新建、三个筛选胶囊、按时间排序的会话行（DESIGN.md §4、§5）。 */
export function ConversationList() {
	const pathname = usePathname();
	const me = useStore((s) => s.me);
	const conversations = useStore((s) => s.conversations);
	const workItems = useStore((s) => s.workItems);
	const connection = useStore((s) => s.connection);
	const map = usePrincipalMap();
	const { open, error } = useOpenDm();
	const [filter, setFilter] = useState<ListFilter>("all");
	const [query, setQuery] = useState("");
	if (!me) return null;

	const meId = me.principal.id;
	const pendingBy = new Map<string, number>();
	for (const w of workItems ?? [])
		if (w.conversationId)
			pendingBy.set(
				w.conversationId,
				(pendingBy.get(w.conversationId) ?? 0) + 1,
			);
	const needle = query.trim().toLowerCase();
	const rows = toRows(conversations, map, meId, pendingBy).filter(
		(r) =>
			(filter === "all" || r.filter === filter) &&
			(!needle ||
				r.title.toLowerCase().includes(needle) ||
				r.preview.toLowerCase().includes(needle)),
	);
	const activeId = pathname.startsWith("/c/") ? pathname.slice(3) : null;
	const twin = me.agents.find((a) => a.role === "front");
	const talkToTwin: EmptyAction | undefined = twin
		? {
				label: `和${twin.principal.displayName}聊聊`,
				onClick: () => void open(twin.principal.id),
			}
		: undefined;

	let empty: { text: string; action?: EmptyAction } | null = null;
	if (rows.length === 0) {
		if (needle) empty = { text: `没有找到"${query.trim()}"相关的会话。` };
		else if (filter === "agents")
			empty = { text: "还没有和代理的会话。", action: talkToTwin };
		else if (filter === "colleagues")
			empty = {
				text: "还没有和同事聊过。",
				action: { label: "打开通讯录", href: appHref("/contacts") },
			};
		else
			empty = {
				text: "这里会出现你和同事、代理的所有会话。",
				action: talkToTwin,
			};
	}

	return (
		<>
			<div className="flex flex-col gap-3 px-4 pt-4 pb-2">
				<div className="flex items-center gap-2">
					<label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-pill bg-surface-2 px-3 text-muted focus-within:ring-2 focus-within:ring-accent">
						<IconSearch size={16} />
						<input
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="搜索"
							aria-label="搜索会话"
							className="min-w-0 flex-1 bg-transparent text-14 text-ink outline-none placeholder:text-muted focus-visible:outline-none"
						/>
					</label>
					<Link
						href={appHref("/new-group")}
						aria-label="新建群聊"
						title="新建群聊"
						className="inline-flex size-9 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink transition-colors duration-150 hover:bg-line"
					>
						<IconPlus size={18} />
					</Link>
				</div>
				<div role="tablist" aria-label="筛选会话" className="flex gap-2">
					{FILTERS.map((f) => (
						<button
							key={f.key}
							type="button"
							role="tab"
							aria-selected={filter === f.key}
							onClick={() => setFilter(f.key)}
							className={cx(
								"h-7 rounded-pill px-3 text-13 transition-colors duration-150",
								filter === f.key
									? "bg-accent-soft font-medium text-accent"
									: "text-muted hover:bg-surface-2 hover:text-ink",
							)}
						>
							{f.label}
						</button>
					))}
				</div>
				{connection === "reconnecting" ? (
					<p role="status" className="text-12 text-muted">
						连接中断，正在重连…
					</p>
				) : null}
				{error ? (
					<p role="alert" className="text-12 text-danger">
						{error}
					</p>
				) : null}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto pb-2">
				{empty ? (
					<EmptyState
						mascotId={`list-${filter}`}
						text={empty.text}
						action={empty.action}
					/>
				) : (
					rows.map((row) => (
						<ConversationRow
							key={row.item.conversation.id}
							row={row}
							map={map}
							meId={meId}
							active={row.item.conversation.id === activeId}
						/>
					))
				)}
			</div>
		</>
	);
}
