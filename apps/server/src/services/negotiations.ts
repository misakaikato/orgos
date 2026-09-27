/**
 * 代理之间的协商会话（kind=negotiation）：两个分身是成员，双方本人是 observer。
 * 它不出现在会话列表里：发起时在两位本人的私聊里落 `negotiation.started`，界面为协商卡片，
 * 卡片经本会话的事件展示每一步。状态存 `conversations.negotiation`，每一步与结束各落一条事件。
 */
import {
	NEGOTIATION_MAX_STEPS,
	type NEGOTIATION_OUTCOMES,
	type NEGOTIATION_STATUSES,
	type NegotiationState,
	NegotiationStateSchema,
	type WorkItem,
} from "@orgos/protocol";
import { eq } from "drizzle-orm";
import { conversationMembers, conversations, principals } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { badRequest, notFound } from "@/lib/errors";
import { requireAgentPrincipal } from "@/services/agent-events";
import { openDm } from "@/services/conversations";
import { transactWithEvents } from "@/services/events";
import { createWorkItem } from "@/services/work-items";

type ConversationRow = typeof conversations.$inferSelect;

async function requireNegotiation(
	s: Scoped,
	conversationId: string,
): Promise<{ row: ConversationRow; state: NegotiationState }> {
	const row = await s.first(
		conversations,
		eq(conversations.id, conversationId),
		eq(conversations.kind, "negotiation"),
	);
	if (!row) throw notFound("协商不存在");
	return { row, state: NegotiationStateSchema.parse(row.negotiation) };
}

async function saveState(
	tx: Scoped,
	conversationId: string,
	state: NegotiationState,
): Promise<void> {
	await tx.executor
		.update(conversations)
		.set({ negotiation: NegotiationStateSchema.parse(state) })
		.where(tx.where(conversations, eq(conversations.id, conversationId)));
}

async function requireHuman(s: Scoped, id: string): Promise<PrincipalRow> {
	const row = await s.first(
		principals,
		eq(principals.id, id),
		eq(principals.kind, "human"),
	);
	if (!row) throw notFound("找不到此人");
	return row;
}

/** 两位本人的私聊（没有则新建，含双方分身）。 */
async function ownersDm(
	s: Scoped,
	initiatorOwnerId: string,
	responderOwnerId: string,
): Promise<string> {
	const owner = await requireHuman(s, initiatorOwnerId);
	const { conversation } = await openDm(s, owner, responderOwnerId);
	return conversation.id;
}

/**
 * 建协商会话：发起方与应答方的代理为成员，双方本人为 observer；
 * 同一事务里在两位本人的私聊落 `negotiation.started`（actor 为发起方代理）。
 */
export async function startNegotiation(
	s: Scoped,
	input: {
		initiatorAgentId: string;
		responderAgentId: string;
		goal: string;
		title: string;
		at?: Date;
	},
): Promise<ConversationRow> {
	const initiator = await requireAgentPrincipal(s, input.initiatorAgentId);
	const responder = await requireAgentPrincipal(s, input.responderAgentId);
	if (initiator.ownerId === responder.ownerId) {
		throw badRequest("协商双方必须属于不同的人");
	}
	const state: NegotiationState = {
		initiatorAgentId: initiator.id,
		responderAgentId: responder.id,
		goal: input.goal,
		step: 0,
		maxSteps: NEGOTIATION_MAX_STEPS,
		state: "running",
	};
	const dmId = await ownersDm(s, initiator.ownerId, responder.ownerId);
	return transactWithEvents(s, async (tx, append) => {
		const row = await tx.insert(conversations, {
			kind: "negotiation",
			title: input.title,
			createdBy: initiator.id,
			negotiation: state,
			...(input.at ? { createdAt: input.at } : {}),
		});
		const members = [
			{ principalId: initiator.id, role: "member" as const },
			{ principalId: responder.id, role: "member" as const },
			{ principalId: initiator.ownerId, role: "observer" as const },
			{ principalId: responder.ownerId, role: "observer" as const },
		];
		for (const m of members) {
			await tx.insert(conversationMembers, { conversationId: row.id, ...m });
		}
		await append({
			conversationId: dmId,
			actorId: initiator.id,
			onBehalfOfId: initiator.ownerId,
			type: "negotiation.started",
			payload: { negotiationConversationId: row.id, goal: input.goal },
			at: input.at,
		});
		return row;
	});
}

/** 协商的一步：落 `negotiation.step`，推进步数，记下最新 proposal。 */
export async function appendNegotiationStep(
	s: Scoped,
	conversationId: string,
	agentId: string,
	reply: {
		status: (typeof NEGOTIATION_STATUSES)[number];
		message: string;
		proposal?: unknown;
	},
	at?: Date,
): Promise<NegotiationState> {
	const agent = await requireAgentPrincipal(s, agentId);
	const { state } = await requireNegotiation(s, conversationId);
	if (state.state === "ended") throw badRequest("协商已结束");
	if (![state.initiatorAgentId, state.responderAgentId].includes(agent.id)) {
		throw notFound("协商不存在");
	}
	const next: NegotiationState = {
		...state,
		step: state.step + 1,
		state: reply.status === "need_owner" ? "waiting_owner" : "running",
		...(reply.proposal === undefined ? {} : { lastProposal: reply.proposal }),
	};
	await transactWithEvents(s, async (tx, append) => {
		await append({
			conversationId,
			actorId: agent.id,
			onBehalfOfId: agent.ownerId,
			type: "negotiation.step",
			payload: {
				step: next.step,
				status: reply.status,
				message: reply.message,
				...(reply.proposal === undefined ? {} : { proposal: reply.proposal }),
			},
			at,
		});
		await saveState(tx, conversationId, next);
	});
	return next;
}

/**
 * 结束协商：落 `negotiation.ended`（actor 为发起方代理）。结果为 agreed 时给双方本人
 * 各建一条 confirmation 待办，提问人为对方的代理，关联两人的私聊（协商卡片所在处）。
 */
export async function endNegotiation(
	s: Scoped,
	conversationId: string,
	outcome: (typeof NEGOTIATION_OUTCOMES)[number],
	at?: Date,
): Promise<WorkItem[]> {
	const { state } = await requireNegotiation(s, conversationId);
	if (state.state === "ended") throw badRequest("协商已结束");
	const initiator = await requireAgentPrincipal(s, state.initiatorAgentId);
	const responder = await requireAgentPrincipal(s, state.responderAgentId);
	const proposal = state.lastProposal;
	const dmId = await ownersDm(s, initiator.ownerId, responder.ownerId);
	return transactWithEvents(s, async (tx, append) => {
		await append({
			conversationId,
			actorId: initiator.id,
			onBehalfOfId: initiator.ownerId,
			type: "negotiation.ended",
			payload: {
				outcome,
				...(proposal === undefined ? {} : { proposal }),
			},
			at,
		});
		await saveState(tx, conversationId, { ...state, state: "ended" });
		if (outcome !== "agreed") return [];
		const items: WorkItem[] = [];
		for (const [self, other] of [
			[initiator, responder],
			[responder, initiator],
		] as const) {
			items.push(
				await createWorkItem(tx, {
					kind: "confirmation",
					payload: { negotiationConversationId: conversationId, proposal },
					title: `确认协商结果：${state.goal}`,
					body: `${other.displayName}与${self.displayName}已谈妥，等你确认。`,
					ownerId: self.ownerId,
					requesterId: other.id,
					conversationId: dmId,
				}),
			);
		}
		return items;
	});
}
