"use client";

import type { WorkItem } from "@orgos/protocol";
import Link from "next/link";
import { useEffect } from "react";
import { MessageCard } from "@/components/conversation/cards";
import { ProposalBlock } from "@/components/conversation/message-item";
import { IconChevronRight } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { Avatar } from "@/components/ui/avatar";
import { SoonButton } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { ConfirmationActions } from "@/components/work-items/confirmation-actions";
import { DecisionForm } from "@/components/work-items/decision-form";
import { appHref } from "@/lib/auth-mode";
import { nameOf } from "@/lib/describe";
import { formatListTime } from "@/lib/format";
import { usePrincipalMap } from "@/lib/hooks";
import type { PrincipalMap } from "@/lib/principals";
import { loadWorkItems, useStore } from "@/lib/store";

const KIND_LABEL: Record<WorkItem["kind"], string> = {
	decision: "需要你拍板",
	confirmation: "请确认协商结果",
	approval: "等你审批",
	question: "有人在问你",
	commitment: "你答应过的事",
};

/** 卡片底部的处理动作：协商确认可处理；审批尚未接通。 */
function ItemActions({ item }: { item: WorkItem }) {
	if (item.kind === "confirmation")
		return <ConfirmationActions workItemId={item.id} />;
	if (item.kind === "approval")
		return (
			<>
				<SoonButton variant="primary">批准</SoonButton>
				<SoonButton variant="danger">拒绝</SoonButton>
			</>
		);
	return null;
}

function WorkItemCard({
	item,
	map,
	meId,
}: {
	item: WorkItem;
	map: PrincipalMap;
	meId: string;
}) {
	const requester = map.get(item.requesterId);
	const actions =
		item.kind === "approval" || item.kind === "confirmation" ? (
			<ItemActions item={item} />
		) : null;
	return (
		<MessageCard
			pending
			title={KIND_LABEL[item.kind]}
			meta={formatListTime(item.createdAt)}
			className="w-full"
			actions={actions}
		>
			<p className="font-semibold break-words">{item.title}</p>
			{item.body && item.body !== item.title ? (
				<p className="mt-1 text-14 whitespace-pre-wrap break-words text-muted">
					{item.body}
				</p>
			) : null}
			<div className="mt-3 flex items-center gap-2 text-13 text-muted">
				{requester ? <Avatar principal={requester} size={20} /> : null}
				<span className="min-w-0 flex-1 truncate">
					来自 {nameOf(item.requesterId, map, meId)}
				</span>
				{item.conversationId ? (
					<Link
						href={appHref(`/c/${item.conversationId}`)}
						className="inline-flex shrink-0 items-center text-accent hover:underline"
					>
						查看会话
						<IconChevronRight size={14} />
					</Link>
				) : null}
			</div>
			{item.kind === "confirmation" && item.payload.proposal !== undefined ? (
				<ProposalBlock proposal={item.payload.proposal} />
			) : null}
			{item.kind === "decision" ? (
				<DecisionForm
					workItemId={item.id}
					requesterName={nameOf(item.requesterId, map, meId)}
					negotiating={item.payload.negotiationConversationId !== undefined}
				/>
			) : null}
		</MessageCard>
	);
}

/** 待办：一切需要本人拍板的事（DESIGN.md §5）。处理后从列表消失（随 work_item 推送）。 */
export default function TodoPage() {
	const me = useStore((s) => s.me);
	const items = useStore((s) => s.workItems);
	const status = useStore((s) => s.workItemsStatus);
	const map = usePrincipalMap();

	useEffect(() => {
		void loadWorkItems();
	}, []);

	if (!me) return null;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title="待办"
				subtitle={
					items && items.length > 0 ? `${items.length} 件等你处理` : null
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-thread px-4 py-6 md:px-6">
					{items === null && status === "error" ? (
						<ErrorState
							text="待办加载失败。"
							onRetry={() => void loadWorkItems()}
						/>
					) : items === null ? (
						<LoadingRows rows={3} />
					) : items.length === 0 ? (
						<EmptyState
							mascotId="todo-empty"
							text="没有需要你拍板的事。代理遇到超出授权的问题时，会出现在这里。"
							action={{ label: "回到消息", href: appHref("/") }}
						/>
					) : (
						<ul className="flex flex-col gap-4">
							{items.map((item) => (
								<li key={item.id}>
									<WorkItemCard item={item} map={map} meId={me.principal.id} />
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
	);
}
