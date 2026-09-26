"use client";

import type { Event } from "@orgos/protocol";
import { Avatar } from "@/components/ui/avatar";
import { cx } from "@/lib/cx";
import { describeEvent } from "@/lib/describe";
import { formatClock, formatDay } from "@/lib/format";
import { agentByline, type PrincipalMap } from "@/lib/principals";
import { type MessageEvent, splitMentions } from "@/lib/thread";

const UNKNOWN = { kind: "human", handle: "unknown", displayName: "?" } as const;

function MessageText({
	text,
	handles,
}: {
	text: string;
	handles: ReadonlySet<string>;
}) {
	return (
		<p className="text-15 whitespace-pre-wrap break-words text-ink [overflow-wrap:anywhere]">
			{splitMentions(text, handles).map((part, i) =>
				part.mention ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: 片段顺序固定，只随文本整体变化。
					<span key={i} className="font-code text-14 font-medium">
						{part.text}
					</span>
				) : (
					part.text
				),
			)}
		</p>
	);
}

function Time({ at, className }: { at: string; className?: string }) {
	return (
		<time
			dateTime={at}
			className={cx("font-code text-12 tabular-nums text-muted", className)}
		>
			{formatClock(at)}
		</time>
	);
}

/** 人的消息：无框。头像 + 名字 + 时间一行，正文在下；合并时只留正文。 */
export function HumanMessage({
	event,
	continued,
	map,
	handles,
}: {
	event: MessageEvent;
	continued: boolean;
	map: PrincipalMap;
	handles: ReadonlySet<string>;
}) {
	const actor = map.get(event.actorId);
	return (
		<article
			className={cx(
				"grid grid-cols-[32px_1fr] gap-x-3",
				continued ? "mt-1" : "mt-4",
			)}
		>
			<div>{continued ? null : <Avatar principal={actor ?? UNKNOWN} />}</div>
			<div className="min-w-0">
				{continued ? null : (
					<header className="flex items-baseline gap-2">
						<span className="truncate text-14 font-medium text-ink">
							{actor?.displayName ?? "已离开的成员"}
						</span>
						<Time at={event.createdAt} />
					</header>
				)}
				<MessageText text={event.payload.text} handles={handles} />
			</div>
		</article>
	);
}

/** 代理的消息：--agent-surface 框，顶部等宽小字标明替谁说话。 */
export function AgentMessage({
	event,
	continued,
	map,
	handles,
}: {
	event: MessageEvent;
	continued: boolean;
	map: PrincipalMap;
	handles: ReadonlySet<string>;
}) {
	const actor = map.get(event.actorId);
	return (
		<article
			className={cx(
				"grid grid-cols-[32px_1fr] gap-x-3",
				continued ? "mt-2" : "mt-4",
			)}
		>
			<div>
				{continued ? null : (
					<Avatar principal={actor ?? { ...UNKNOWN, kind: "agent" }} />
				)}
			</div>
			<div className="min-w-0 rounded-box bg-agent-surface px-3.5 py-3">
				<header className="mb-1 flex items-baseline gap-2">
					<span className="truncate font-code text-12 text-muted">
						{actor ? agentByline(actor, map) : "代理"}
					</span>
					<Time at={event.createdAt} className="ml-auto shrink-0" />
				</header>
				<MessageText text={event.payload.text} handles={handles} />
			</div>
		</article>
	);
}

/** 其他事件：一行紧凑的等宽灰字。 */
export function EventLine({
	event,
	map,
	meId,
}: {
	event: Event;
	map: PrincipalMap;
	meId: string;
}) {
	return (
		<p className="mt-3 grid grid-cols-[32px_1fr] gap-x-3 font-code text-12 text-muted">
			<span />
			<span className="flex min-w-0 gap-2">
				<span className="min-w-0 break-words [overflow-wrap:anywhere]">
					{describeEvent(event, map, meId)}
				</span>
				<Time at={event.createdAt} className="ml-auto shrink-0" />
			</span>
		</p>
	);
}

export function DayDivider({ at }: { at: string }) {
	return (
		<div className="mt-6 flex items-center gap-3">
			<span className="h-px flex-1 bg-line" />
			<span className="font-code text-12 text-muted">{formatDay(at)}</span>
			<span className="h-px flex-1 bg-line" />
		</div>
	);
}

export function UnreadDivider() {
	return (
		<div className="mt-4 flex items-center gap-3">
			<span className="h-px flex-1 bg-line" />
			<span className="text-12 font-medium text-muted">以下为新消息</span>
			<span className="h-px flex-1 bg-line" />
		</div>
	);
}
