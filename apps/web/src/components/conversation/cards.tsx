"use client";

import type { ReactNode } from "react";
import { fallbackPrincipal } from "@/components/conversation/message-item";
import { Avatar } from "@/components/ui/avatar";
import { ApprovalActions } from "@/components/work-items/approval-actions";
import { ApprovalDetails } from "@/components/work-items/approval-details";
import { DecisionForm } from "@/components/work-items/decision-form";
import { cx } from "@/lib/cx";
import { APPROVAL_OUTCOME_LABEL, capabilityLabel } from "@/lib/device";
import { formatClock } from "@/lib/format";
import { onBehalfLabel, type PrincipalMap } from "@/lib/principals";
import { useStore } from "@/lib/store";
import type {
	ApprovalEvent,
	ApprovalResolvedEvent,
	EscalationEvent,
	EscalationResolvedEvent,
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
export function CardRow({
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

function titleOf(
	resolved: EscalationResolvedEvent | null,
	mine: boolean,
	ownerName: string,
): string {
	const who = mine ? "你" : ownerName;
	if (resolved)
		return resolved.payload.action === "decline"
			? `${who}暂不答复`
			: `${who}已答复`;
	return mine ? "需要你答复" : `已转给${ownerName}本人，等待答复`;
}

/**
 * 上报卡片：代理把超出授权的问题转给本人。状态完全由会话事件派生——
 * 有对应的 escalation.resolved 即为已完成。本人看到答复框，其他人看到"已转给某某本人"。
 */
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
	const workItemId = event.payload.workItemId;
	const negotiating = event.payload.negotiationConversationId !== undefined;
	const requesterId = useStore(
		(s) => s.workItems?.find((w) => w.id === workItemId)?.requesterId,
	);
	const agent = map.get(event.actorId);
	const owner = agent ? onBehalfLabel(agent, map, meId) : null;
	const mine = owner === "你";
	const ownerName = owner ?? "本人";
	const agentName = agent?.displayName ?? "代理";
	const requesterName = requesterId
		? (map.get(requesterId)?.displayName ?? "对方")
		: "对方";
	return (
		<CardRow actorId={event.actorId} map={map}>
			<MessageCard
				pending={!resolved}
				title={titleOf(resolved, mine, ownerName)}
				meta={formatClock((resolved ?? event).createdAt)}
			>
				<p className="whitespace-pre-wrap break-words">
					{event.payload.question}
				</p>
				{resolved?.payload.text ? (
					<p className="mt-2 rounded-row bg-surface-2 px-3 py-2 text-14 whitespace-pre-wrap break-words">
						{resolved.payload.text}
					</p>
				) : null}
				{!resolved && mine ? (
					<DecisionForm
						workItemId={workItemId}
						requesterName={requesterName}
						negotiating={negotiating}
					/>
				) : (
					<p className="mt-2 text-12 text-muted">
						{negotiating
							? resolved
								? `${agentName}会据此接着协商`
								: `${agentName}在协商中请${ownerName}拍板，答复后接着协商`
							: resolved
								? `${agentName}会在这里接着回复`
								: `${agentName}转来，${ownerName}答复后会在这里接着回复`}
					</p>
				)}
			</MessageCard>
		</CardRow>
	);
}

const APPROVAL_NOTE = {
	approve: "已允许，",
	deny: "已拒绝，没有执行。",
	expired: "10 分钟内没有处理，已过期，视为拒绝，没有执行。",
	cancelled: "等待期间有了新消息、运行被停止或任务已结束，已取消，没有执行。",
} as const;

/**
 * 审批卡片：代理要在本人的设备上写文件、执行命令，或外部助手请求使用工具。
 * 显示设备名、能力（或外部助手请求的工具）与完整参数；外部助手的请求带它给出的选项，
 * 本人选哪个就原样回给它。本人看到按钮，其他成员只看到等待状态。
 * 状态由会话事件派生——有对应的 approval.resolved 即为完成态。
 */
export function ApprovalCard({
	event,
	resolved,
	map,
	meId,
}: {
	event: ApprovalEvent;
	resolved: ApprovalResolvedEvent | null;
	map: PrincipalMap;
	meId: string;
}) {
	const { workItemId, runnerName, capability, args, toolCall, options } =
		event.payload;
	const mine = event.onBehalfOfId === meId;
	const agentName = map.get(event.actorId)?.displayName ?? "代理";
	const ownerName = event.onBehalfOfId
		? (map.get(event.onBehalfOfId)?.displayName ?? "本人")
		: "本人";
	const outcome = resolved?.payload.outcome ?? null;
	const chosen = options?.find(
		(o) => o.optionId === resolved?.payload.optionId,
	);
	const title = outcome
		? `${APPROVAL_OUTCOME_LABEL[outcome]}：${capabilityLabel(capability)}`
		: mine
			? "需要你批准"
			: `等${ownerName}批准`;
	return (
		<CardRow actorId={event.actorId} map={map}>
			<MessageCard
				pending={!resolved}
				title={title}
				meta={formatClock((resolved ?? event).createdAt)}
				actions={
					!resolved && mine ? (
						<ApprovalActions workItemId={workItemId} options={options} />
					) : null
				}
			>
				<p className="break-words">
					{toolCall && capability !== "shell.exec"
						? `${agentName}请求：${toolCall.title}`
						: `${agentName}想在“${runnerName}”上${capabilityLabel(capability)}`}
				</p>
				<ApprovalDetails capability={capability} args={args} />
				{outcome ? (
					<p className="mt-2 text-12 text-muted">
						{outcome === "approve"
							? chosen
								? `${APPROVAL_NOTE.approve}选了“${chosen.name}”，${agentName}会接着做。`
								: `${APPROVAL_NOTE.approve}${agentName}会在这里给出结果。`
							: APPROVAL_NOTE[outcome]}
					</p>
				) : mine ? null : (
					<p className="mt-2 text-12 text-muted">{ownerName}允许后才会执行。</p>
				)}
			</MessageCard>
		</CardRow>
	);
}
