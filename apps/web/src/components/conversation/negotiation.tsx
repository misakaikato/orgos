"use client";

import type { NEGOTIATION_STATUSES, Principal } from "@orgos/protocol";
import { useEffect, useState } from "react";
import { CardRow, MessageCard } from "@/components/conversation/cards";
import {
	AgentName,
	fallbackPrincipal,
	ProposalBlock,
} from "@/components/conversation/message-item";
import { IconClose } from "@/components/icons";
import { Mascot } from "@/components/mascot";
import { PersonAvatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/badge";
import { Button, IconButton, SoonButton } from "@/components/ui/button";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { cx } from "@/lib/cx";
import { nameOf, OUTCOME_LABEL } from "@/lib/describe";
import { formatClock, formatStamp } from "@/lib/format";
import { type NegotiationView, negotiationView } from "@/lib/negotiation";
import type { PrincipalMap } from "@/lib/principals";
import { ensureEvents, loadEvents, useStore } from "@/lib/store";
import type { NegotiationStartedEvent } from "@/lib/thread";

export const STEP_LABEL: Record<(typeof NEGOTIATION_STATUSES)[number], string> =
	{
		continue: "提议",
		agree: "同意",
		reject: "拒绝",
		need_owner: "请本人定",
	};

const EMPTY: never[] = [];

/** 协商卡片的数据：协商会话的事件、两位分身与各自的本人、我的确认待办。 */
function useNegotiation(event: NegotiationStartedEvent, map: PrincipalMap) {
	const negotiationId = event.payload.negotiationConversationId;
	const events = useStore((s) => s.events[negotiationId]) ?? EMPTY;
	const status = useStore((s) => s.eventsStatus[negotiationId]);
	const dmMembers = useStore(
		(s) =>
			s.conversations.find((x) => x.conversation.id === event.conversationId)
				?.members,
	);
	const myConfirmation = useStore((s) =>
		s.workItems?.find(
			(w) =>
				w.kind === "confirmation" &&
				w.payload.negotiationConversationId === negotiationId,
		),
	);
	useEffect(() => {
		ensureEvents(negotiationId);
	}, [negotiationId]);

	const initiator =
		map.get(event.actorId) ?? fallbackPrincipal(event.actorId, "agent");
	const responder =
		dmMembers?.find((p) => p.kind === "agent" && p.id !== initiator.id) ?? null;
	const owners = [initiator, responder].flatMap((twin) => {
		const owner = twin?.ownerId ? map.get(twin.ownerId) : undefined;
		return owner ? [owner] : [];
	});
	return {
		negotiationId,
		status,
		view: negotiationView(events),
		initiator,
		responder,
		owners,
		confirmPending: Boolean(myConfirmation),
	};
}

function titleOf(view: NegotiationView, confirmPending: boolean): string {
	if (confirmPending) return "两位的分身谈妥了，等你确认";
	if (view.outcome === "agreed") return "两位的分身谈妥了";
	if (view.outcome) return "两位的分身没谈成";
	return "两位的分身正在约时间";
}

function progressOf(view: NegotiationView): string {
	const last = view.steps.at(-1);
	if (!last) return "刚开始";
	return `第 ${last.payload.step} 步 · ${STEP_LABEL[last.payload.status]}`;
}

function ConfirmState({
	owner,
	view,
	meId,
}: {
	owner: Principal;
	view: NegotiationView;
	meId: string;
}) {
	const action = view.confirmations.get(owner.id);
	return (
		<li className="flex items-center gap-2 text-13">
			<PersonAvatar principal={owner} size={20} />
			<span className="min-w-0 flex-1 truncate text-ink">
				{owner.id === meId ? "你" : owner.displayName}
			</span>
			{action === "confirm" ? (
				<Tag tone="good">已确认</Tag>
			) : action === "reject" ? (
				<Tag tone="danger">已驳回</Tag>
			) : (
				<Tag>待确认</Tag>
			)}
		</li>
	);
}

/**
 * 协商卡片（DESIGN.md §4）：嵌在两人私聊里，显示目标、当前步数与状态、双方团子；
 * 结束后显示结果与两人各自的确认状态；"查看过程"在右侧抽屉按时间线展示每一步与 proposal。
 */
export function NegotiationCard({
	event,
	map,
	meId,
}: {
	event: NegotiationStartedEvent;
	map: PrincipalMap;
	meId: string;
}) {
	const n = useNegotiation(event, map);
	const [drawer, setDrawer] = useState(false);
	const { view } = n;
	return (
		<CardRow actorId={event.actorId} map={map}>
			<MessageCard
				pending={n.confirmPending}
				title={titleOf(view, n.confirmPending)}
				meta={formatClock(event.createdAt)}
				actions={
					<>
						{n.confirmPending ? (
							<>
								<SoonButton variant="primary">确认</SoonButton>
								<SoonButton variant="danger">驳回</SoonButton>
							</>
						) : null}
						<Button onClick={() => setDrawer(true)}>查看过程</Button>
					</>
				}
			>
				<p className="font-semibold break-words">{event.payload.goal}</p>
				<div className="mt-3 flex items-center gap-2">
					<Mascot
						id={n.initiator.id}
						size={32}
						state={view.outcome ? "idle" : "working"}
					/>
					{n.responder ? (
						<Mascot
							id={n.responder.id}
							size={32}
							state={view.outcome ? "idle" : "working"}
						/>
					) : null}
					<span className="min-w-0 flex-1 truncate text-13 text-muted">
						{n.status === "error"
							? "协商过程读取失败"
							: n.status !== "ready"
								? "正在读取协商过程…"
								: view.outcome
									? `共 ${view.steps.length} 步`
									: progressOf(view)}
					</span>
				</div>
				{view.outcome ? (
					<>
						<p className="mt-3 flex items-center gap-2">
							<span
								aria-hidden="true"
								className={cx(
									"size-2 shrink-0 rounded-pill",
									view.outcome === "agreed" ? "bg-good" : "bg-danger",
								)}
							/>
							{OUTCOME_LABEL[view.outcome]}
						</p>
						{view.outcome === "agreed" && view.proposal !== undefined ? (
							<ProposalBlock proposal={view.proposal} />
						) : null}
						{view.outcome === "agreed" && n.owners.length > 0 ? (
							<ul className="mt-3 flex flex-col gap-1.5">
								{n.owners.map((o) => (
									<ConfirmState key={o.id} owner={o} view={view} meId={meId} />
								))}
							</ul>
						) : null}
					</>
				) : null}
			</MessageCard>
			{drawer ? (
				<NegotiationDrawer
					goal={event.payload.goal}
					negotiationId={n.negotiationId}
					status={n.status}
					view={view}
					map={map}
					meId={meId}
					onClose={() => setDrawer(false)}
				/>
			) : null}
		</CardRow>
	);
}

/** 协商过程抽屉：按时间线展示每一步（谁、状态、说明、proposal）与结果。 */
function NegotiationDrawer({
	goal,
	negotiationId,
	status,
	view,
	map,
	meId,
	onClose,
}: {
	goal: string;
	negotiationId: string;
	status: string | undefined;
	view: NegotiationView;
	map: PrincipalMap;
	meId: string;
	onClose: () => void;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="fixed inset-0 z-30 flex justify-end">
			<button
				type="button"
				aria-label="关闭协商过程"
				className="flex-1 bg-scrim"
				onClick={onClose}
			/>
			<aside
				aria-label="协商过程"
				className="flex h-full w-inspector max-w-full animate-pop-in flex-col bg-bg shadow-float"
			>
				<header className="flex h-header shrink-0 items-center justify-between gap-2 border-b border-line px-4">
					<h2 className="text-16 font-semibold text-ink">协商过程</h2>
					<IconButton label="关闭" onClick={onClose}>
						<IconClose size={18} />
					</IconButton>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
					<p className="text-12 text-muted">目标</p>
					<p className="mt-1 text-14 font-semibold break-words text-ink">
						{goal}
					</p>
					{status === "error" ? (
						<ErrorState
							text="协商过程读取失败。"
							onRetry={() => void loadEvents(negotiationId)}
						/>
					) : status !== "ready" ? (
						<LoadingRows rows={3} />
					) : view.steps.length === 0 ? (
						<p className="mt-6 text-13 text-muted">两位分身还没有开始交涉。</p>
					) : (
						<ol className="mt-4 flex flex-col gap-4 border-l-2 border-line pl-4">
							{view.steps.map((s) => {
								const agent =
									map.get(s.actorId) ?? fallbackPrincipal(s.actorId, "agent");
								return (
									<li key={s.id} className="flex flex-col gap-1.5">
										<div className="flex items-center gap-2">
											<Mascot id={agent.id} size={24} />
											<AgentName agent={agent} map={map} meId={meId} />
											<time
												dateTime={s.createdAt}
												className="ml-auto shrink-0 text-12 text-muted"
											>
												{formatStamp(s.createdAt)}
											</time>
										</div>
										<div>
											<Tag
												tone={
													s.payload.status === "reject" ? "danger" : "neutral"
												}
											>
												{`第 ${s.payload.step} 步 · ${STEP_LABEL[s.payload.status]}`}
											</Tag>
										</div>
										<p className="text-14 whitespace-pre-wrap break-words text-ink">
											{s.payload.message}
										</p>
										{s.payload.proposal !== undefined ? (
											<ProposalBlock proposal={s.payload.proposal} />
										) : null}
									</li>
								);
							})}
							{view.outcome ? (
								<li className="flex items-center gap-2 text-14 font-semibold text-ink">
									<span
										aria-hidden="true"
										className={cx(
											"size-2 shrink-0 rounded-pill",
											view.outcome === "agreed" ? "bg-good" : "bg-danger",
										)}
									/>
									{OUTCOME_LABEL[view.outcome]}
								</li>
							) : null}
							{[...view.confirmations].map(([who, action]) => (
								<li key={who} className="text-13 text-muted">
									{nameOf(who, map, meId)}
									{action === "confirm" ? "确认了结果" : "驳回了结果"}
								</li>
							))}
						</ol>
					)}
				</div>
			</aside>
		</div>
	);
}
