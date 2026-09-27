"use client";

import type { ReactNode } from "react";
import {
	fallbackPrincipal,
	ProposalBlock,
} from "@/components/conversation/message-item";
import { Avatar } from "@/components/ui/avatar";
import { SoonButton } from "@/components/ui/button";
import { cx } from "@/lib/cx";
import { OUTCOME_LABEL } from "@/lib/describe";
import { formatClock } from "@/lib/format";
import { onBehalfLabel, type PrincipalMap } from "@/lib/principals";
import type {
	EscalationEvent,
	EscalationResolvedEvent,
	OutcomeEvent,
} from "@/lib/thread";

/**
 * 飞书式消息卡片（DESIGN.md §4）：宽 360、圆角 12、1px 描边、白底；
 * 40px 标题栏——待本人处理用 --pending-soft 底，已完成用 --surface-2 底；底部按钮行最多一个主按钮。
 */
export function MessageCard({
	title,
	pending,
	meta,
	children,
	actions,
	className,
}: {
	title: ReactNode;
	pending: boolean;
	/** 标题栏右侧的小字（时间等）。 */
	meta?: ReactNode;
	children: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<article
			className={cx(
				"w-card max-w-full overflow-hidden rounded-card border border-line bg-bg transition-shadow duration-150 hover:shadow-card-hover",
				className,
			)}
		>
			<header
				className={cx(
					"flex h-10 items-center gap-2 px-4 text-14 font-semibold",
					pending
						? "bg-pending-soft text-pending-ink"
						: "bg-surface-2 text-ink",
				)}
			>
				{pending ? (
					<span
						aria-hidden="true"
						className="size-2 shrink-0 rounded-pill bg-pending"
					/>
				) : null}
				<span className="min-w-0 flex-1 truncate">{title}</span>
				{meta ? (
					<span className="shrink-0 text-12 font-normal text-muted">
						{meta}
					</span>
				) : null}
			</header>
			<div className="px-4 py-3 text-14 text-ink">{children}</div>
			{actions ? (
				<footer className="flex flex-wrap gap-2 px-4 pb-4">{actions}</footer>
			) : null}
		</article>
	);
}

/** 卡片在消息列里的位置：与代理气泡同列居左，左侧是发出它的代理的团子。 */
function CardRow({
	actorId,
	map,
	children,
}: {
	actorId: string;
	map: PrincipalMap;
	children: ReactNode;
}) {
	const actor = map.get(actorId) ?? fallbackPrincipal(actorId, "agent");
	return (
		<div className="mt-3 grid grid-cols-[32px_minmax(0,1fr)] gap-x-2">
			<div className="pt-0.5">
				<Avatar principal={actor} size={32} />
			</div>
			<div className="min-w-0">{children}</div>
		</div>
	);
}

/** 上报卡片：代理把超出授权的问题转给本人。 */
export function EscalationCard({
	event,
	resolved,
	map,
	meId,
}: {
	event: EscalationEvent;
	resolved: EscalationResolvedEvent | null;
	map: PrincipalMap;
	meId: string;
}) {
	const agent = map.get(event.actorId);
	const owner = agent ? onBehalfLabel(agent, map, meId) : null;
	const mine = owner === "你";
	const ownerName = owner ?? "本人";
	const title = resolved
		? `${mine ? "你" : ownerName}已答复`
		: mine
			? "需要你答复"
			: `已转给${ownerName}本人`;
	return (
		<CardRow actorId={event.actorId} map={map}>
			<MessageCard
				pending={!resolved}
				title={title}
				meta={formatClock(event.createdAt)}
				actions={
					!resolved && mine ? (
						<>
							<SoonButton variant="primary">答复</SoonButton>
							<SoonButton>存为资料</SoonButton>
						</>
					) : null
				}
			>
				<p className="whitespace-pre-wrap break-words">
					{event.payload.question}
				</p>
				{resolved?.payload.text ? (
					<p className="mt-2 rounded-row bg-surface-2 px-3 py-2 text-14 break-words">
						{resolved.payload.text}
					</p>
				) : null}
				<p className="mt-2 text-12 text-muted">
					{resolved
						? `${agent?.displayName ?? "代理"}转来的问题，已处理`
						: `${agent?.displayName ?? "代理"}转来，等${mine ? "你" : ownerName}拍板后回复对方`}
				</p>
			</MessageCard>
		</CardRow>
	);
}

/** 协商结果卡片：谈妥后等双方本人确认；未谈成则只是结果。 */
export function OutcomeCard({
	event,
	confirmPending,
	map,
}: {
	event: OutcomeEvent;
	/** 我有这场协商的确认待办尚未处理。 */
	confirmPending: boolean;
	map: PrincipalMap;
}) {
	const agreed = event.payload.outcome === "agreed";
	const title = confirmPending
		? "请确认协商结果"
		: agreed
			? "协商已谈妥"
			: "协商未谈成";
	return (
		<CardRow actorId={event.actorId} map={map}>
			<MessageCard
				pending={confirmPending}
				title={title}
				meta={formatClock(event.createdAt)}
				actions={
					confirmPending ? (
						<>
							<SoonButton variant="primary">确认</SoonButton>
							<SoonButton variant="danger">驳回</SoonButton>
						</>
					) : null
				}
			>
				<p className="flex items-center gap-2">
					<span
						aria-hidden="true"
						className={cx(
							"size-2 shrink-0 rounded-pill",
							agreed ? "bg-good" : "bg-danger",
						)}
					/>
					{OUTCOME_LABEL[event.payload.outcome]}
				</p>
				{event.payload.proposal !== undefined ? (
					<ProposalBlock proposal={event.payload.proposal} />
				) : null}
			</MessageCard>
		</CardRow>
	);
}
