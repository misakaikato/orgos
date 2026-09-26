"use client";

import type { Event } from "@orgos/protocol";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	AgentMessage,
	DayDivider,
	EventLine,
	HumanMessage,
	UnreadDivider,
} from "@/components/conversation/message-item";
import { IconArrowDown } from "@/components/icons";
import { EmptyState } from "@/components/ui/states";
import type { PrincipalMap } from "@/lib/principals";
import { buildThreadRows, type ThreadRow } from "@/lib/thread";

/** 离底部多近算"在底部"。 */
const BOTTOM_SLACK_PX = 48;

function isAtBottom(el: HTMLElement): boolean {
	return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
}

function scrollToBottom(el: HTMLElement | null): void {
	if (el) el.scrollTop = el.scrollHeight;
}

function Row({
	row,
	map,
	meId,
	handles,
}: {
	row: ThreadRow;
	map: PrincipalMap;
	meId: string;
	handles: ReadonlySet<string>;
}) {
	switch (row.kind) {
		case "day":
			return <DayDivider at={row.at} />;
		case "unread":
			return (
				<div data-unread-divider>
					<UnreadDivider />
				</div>
			);
		case "human":
			return (
				<HumanMessage
					event={row.event}
					continued={row.continued}
					map={map}
					handles={handles}
				/>
			);
		case "agent":
			return (
				<AgentMessage
					event={row.event}
					continued={row.continued}
					map={map}
					handles={handles}
				/>
			);
		case "line":
			return <EventLine event={row.event} map={map} meId={meId} />;
	}
}

/**
 * 消息列：首次打开停在未读分隔处（没有则到底）；停在底部时新消息自动跟随，
 * 不在底部时出现"有新消息"按钮。`onBottomChange` 报告是否停在底部（用于已读上报）。
 */
export function MessageList({
	events,
	map,
	meId,
	unreadAfter,
	handles,
	onBottomChange,
	emptyText,
}: {
	events: readonly Event[];
	map: PrincipalMap;
	meId: string;
	unreadAfter: number | null;
	handles: ReadonlySet<string>;
	onBottomChange: (atBottom: boolean) => void;
	emptyText: string;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);
	const positioned = useRef(false);
	const lastSeen = useRef(events.at(-1)?.seq ?? 0);
	const [hasNewBelow, setHasNewBelow] = useState(false);

	const rows = useMemo(
		() => buildThreadRows(events, map, meId, unreadAfter),
		[events, map, meId, unreadAfter],
	);

	// 首次定位 + 新消息跟随（布局完成后、绘制前执行，避免跳动）。
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const newest = events.at(-1);
		if (!positioned.current) {
			positioned.current = true;
			const divider = el.querySelector<HTMLElement>("[data-unread-divider]");
			if (divider)
				el.scrollTop = Math.max(0, divider.offsetTop - el.clientHeight / 3);
			else scrollToBottom(el);
		} else if (newest && (newest.seq ?? 0) > lastSeen.current) {
			if (atBottom.current || newest.actorId === meId) scrollToBottom(el);
			else setHasNewBelow(true);
		}
		lastSeen.current = newest?.seq ?? 0;
		const bottom = isAtBottom(el);
		atBottom.current = bottom;
		onBottomChange(bottom);
	}, [events, meId, onBottomChange]);

	// 内容高度变化（字体加载、窗口缩放）时保持贴底。
	useEffect(() => {
		const el = scroller.current;
		const inner = el?.firstElementChild;
		if (!el || !inner) return;
		const ro = new ResizeObserver(() => {
			if (atBottom.current) scrollToBottom(el);
		});
		ro.observe(inner);
		return () => ro.disconnect();
	}, []);

	const onScroll = () => {
		const el = scroller.current;
		if (!el) return;
		const bottom = isAtBottom(el);
		if (bottom !== atBottom.current) {
			atBottom.current = bottom;
			onBottomChange(bottom);
		}
		if (bottom) setHasNewBelow(false);
	};

	return (
		<div className="relative min-h-0 flex-1">
			<div
				ref={scroller}
				onScroll={onScroll}
				className="h-full overflow-y-auto overflow-x-hidden"
				role="log"
				aria-live="polite"
				aria-label="消息"
			>
				<div className="max-w-thread px-4 pt-2 pb-6 md:px-6">
					{rows.length === 0 ? <EmptyState text={emptyText} /> : null}
					{rows.map((row) => (
						<Row
							key={row.key}
							row={row}
							map={map}
							meId={meId}
							handles={handles}
						/>
					))}
				</div>
			</div>
			{hasNewBelow ? (
				<button
					type="button"
					onClick={() => {
						scrollToBottom(scroller.current);
						setHasNewBelow(false);
					}}
					className="absolute bottom-4 left-4 inline-flex h-8 items-center gap-2 rounded-capsule border border-pop-border bg-surface px-3 text-13 text-ink shadow-popover md:left-6"
				>
					<IconArrowDown size={16} />
					有新消息
				</button>
			) : null}
		</div>
	);
}
