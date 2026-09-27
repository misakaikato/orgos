"use client";

import type { NEGOTIATION_STATUSES, Principal } from "@orgos/protocol";
import { type ReactNode, useState } from "react";
import { IconCheck, IconChevronRight, IconClose } from "@/components/icons";
import { mascotInkClass } from "@/components/mascot";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/badge";
import { cx } from "@/lib/cx";
import { describeEvent } from "@/lib/describe";
import { formatClock, formatStamp } from "@/lib/format";
import { onBehalfLabel, type PrincipalMap } from "@/lib/principals";
import {
	type ActionEvent,
	type BubbleSide,
	type MessageEvent,
	type StepEvent,
	type SystemEvent,
	splitMentions,
} from "@/lib/thread";

const STEP_LABEL: Record<(typeof NEGOTIATION_STATUSES)[number], string> = {
	continue: "提议",
	agree: "同意",
	reject: "拒绝",
	need_owner: "请本人定",
};

/** 找不到主体时的占位（已离开或不可见的成员）。 */
export function fallbackPrincipal(
	id: string,
	kind: Principal["kind"] = "human",
): Pick<Principal, "id" | "kind" | "handle" | "displayName" | "ownerId"> {
	return {
		id,
		kind,
		handle: "unknown",
		displayName: "已离开的成员",
		ownerId: null,
	};
}

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
					<span key={i} className="font-medium text-accent">
						{part.text}
					</span>
				) : (
					part.text
				),
			)}
		</p>
	);
}

/** 悬停气泡时出现的时间。 */
function HoverTime({ at }: { at: string }) {
	return (
		<time
			dateTime={at}
			className="shrink-0 self-end pb-1 text-12 text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100"
		>
			{formatClock(at)}
		</time>
	);
}

/** 代理动作折叠行："做了 N 件事 ›"，点开展开清单。 */
export function ActionsFold({
	actions,
	lead,
}: {
	actions: readonly ActionEvent[];
	/** 行首的说明（单列时是代理名字）。 */
	lead?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	if (actions.length === 0) return null;
	return (
		<div className="mt-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="inline-flex items-center gap-1 rounded-pill text-12 text-muted transition-colors duration-150 hover:text-ink"
			>
				{lead}
				做了 {actions.length} 件事
				<IconChevronRight
					size={14}
					className={cx(
						"transition-transform duration-150",
						open && "rotate-90",
					)}
				/>
			</button>
			{open ? (
				<ul className="mt-1 flex flex-col gap-1 border-l-2 border-line pl-3">
					{actions.map((a) => (
						<li
							key={a.id}
							className="flex items-start gap-1.5 text-12 text-muted"
						>
							{a.payload.ok ? (
								<IconCheck size={14} className="mt-0.5 shrink-0 text-good" />
							) : (
								<IconClose size={14} className="mt-0.5 shrink-0 text-danger" />
							)}
							<span className="min-w-0 break-words">{a.payload.summary}</span>
							<time dateTime={a.createdAt} className="ml-auto shrink-0 pl-2">
								{formatClock(a.createdAt)}
							</time>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/** 代理名字行：团子色名字 + 灰色"代谁"胶囊。 */
export function AgentName({
	agent,
	map,
	meId,
}: {
	agent: Pick<Principal, "id" | "displayName"> & { ownerId?: string | null };
	map: PrincipalMap;
	meId: string;
}) {
	const owner = onBehalfLabel({ ownerId: agent.ownerId ?? null }, map, meId);
	return (
		<span className="flex min-w-0 items-center gap-1.5">
			<span
				className={cx(
					"truncate text-12 font-semibold",
					mascotInkClass(agent.id),
				)}
			>
				{agent.displayName}
			</span>
			{owner ? <Tag>{`代${owner}`}</Tag> : null}
		</span>
	);
}

/**
 * 一条气泡（DESIGN.md §4）：
 * - 我：靠右，--accent-soft 填充，无头像；
 * - 他人：靠左，--surface-2 填充；群聊带 32px 头像与名字；
 * - 代理：靠左，--bg 底 + 描边；团子头像、团子色名字与"代谁"胶囊。
 */
export function Bubble({
	event,
	side,
	continued,
	actions,
	map,
	meId,
	handles,
	isGroup,
}: {
	event: MessageEvent | StepEvent;
	side: BubbleSide;
	continued: boolean;
	actions: readonly ActionEvent[];
	map: PrincipalMap;
	meId: string;
	handles: ReadonlySet<string>;
	isGroup: boolean;
}) {
	const gap = continued ? "mt-0.5" : "mt-3";
	const text =
		event.type === "message.posted"
			? event.payload.text
			: event.payload.message;

	if (side === "me") {
		return (
			<div className={cx("group flex justify-end gap-2", gap)}>
				<HoverTime at={event.createdAt} />
				<div className="max-w-[72%] rounded-bubble bg-accent-soft px-3.5 py-2.5">
					<MessageText text={text} handles={handles} />
				</div>
			</div>
		);
	}

	const actor =
		map.get(event.actorId) ??
		fallbackPrincipal(event.actorId, side === "agent" ? "agent" : "human");
	const agent = side === "agent";
	const withAvatar = agent || isGroup;
	return (
		<div
			className={cx(
				"group grid gap-x-2",
				withAvatar ? "grid-cols-[32px_minmax(0,1fr)]" : "grid-cols-1",
				gap,
			)}
		>
			{withAvatar ? (
				<div className="pt-0.5">
					{continued ? null : <Avatar principal={actor} size={32} />}
				</div>
			) : null}
			<div className="flex min-w-0 flex-col items-start">
				{continued || !withAvatar ? null : agent ? (
					<div className="mb-1 max-w-full">
						<AgentName agent={actor} map={map} meId={meId} />
					</div>
				) : (
					<span className="mb-1 max-w-full truncate text-12 text-muted">
						{actor.displayName}
					</span>
				)}
				<div className="flex w-full items-end gap-2">
					<div
						className={cx(
							"min-w-0 max-w-[72%] rounded-bubble px-3.5 py-2.5",
							agent ? "border border-line bg-bg" : "bg-surface-2",
						)}
					>
						{event.type === "negotiation.step" ? (
							<div className="mb-1.5 flex items-center gap-2">
								<Tag
									tone={
										event.payload.status === "reject" ? "danger" : "neutral"
									}
								>
									{`第 ${event.payload.step} 步 · ${STEP_LABEL[event.payload.status]}`}
								</Tag>
							</div>
						) : null}
						<MessageText text={text} handles={handles} />
						{event.type === "negotiation.step" &&
						event.payload.proposal !== undefined ? (
							<ProposalBlock proposal={event.payload.proposal} />
						) : null}
					</div>
					<HoverTime at={event.createdAt} />
				</div>
				<ActionsFold actions={actions} />
			</div>
		</div>
	);
}

/** 协商 proposal 的 JSON（DESIGN.md §3 允许的等宽场景）。 */
export function ProposalBlock({ proposal }: { proposal: unknown }) {
	return (
		<pre className="mt-2 overflow-x-auto rounded-row bg-surface-2 px-3 py-2 font-code text-12 whitespace-pre-wrap break-words text-ink">
			{JSON.stringify(proposal, null, 2)}
		</pre>
	);
}

/** 单独一行的代理动作（之后没有它的气泡可以折叠进去）。 */
export function ActionsRow({
	actorId,
	actions,
	map,
}: {
	actorId: string;
	actions: readonly ActionEvent[];
	map: PrincipalMap;
}) {
	const actor = map.get(actorId) ?? fallbackPrincipal(actorId, "agent");
	return (
		<div className="mt-3 grid grid-cols-[32px_minmax(0,1fr)] gap-x-2">
			<Avatar principal={actor} size={32} />
			<div className="flex min-w-0 items-center">
				<ActionsFold
					actions={actions}
					lead={
						<span className={cx("font-semibold", mascotInkClass(actorId))}>
							{actor.displayName}
						</span>
					}
				/>
			</div>
		</div>
	);
}

/** 系统事件：居中灰色小字。 */
export function SystemLine({
	event,
	map,
	meId,
}: {
	event: SystemEvent;
	map: PrincipalMap;
	meId: string;
}) {
	return (
		<p className="mt-3 px-8 text-center text-12 text-muted">
			{describeEvent(event, map, meId)}
		</p>
	);
}

/** 间隔 10 分钟以上的时间分隔。 */
export function StampDivider({ at }: { at: string }) {
	return (
		<p className="mt-5 mb-1 text-center text-12 text-muted">
			<time dateTime={at}>{formatStamp(at)}</time>
		</p>
	);
}

export function UnreadDivider() {
	return (
		<div className="mt-4 flex items-center gap-3">
			<span className="h-px flex-1 bg-line" />
			<span className="text-12 font-medium text-accent">以下为新消息</span>
			<span className="h-px flex-1 bg-line" />
		</div>
	);
}
