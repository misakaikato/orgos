/**
 * 代理之间的协商会话（kind=negotiation）：两个分身是成员，双方拍板人是 observer。
 * 分身的本人可以是人或单元；单元一方由它的分身出面，拍板人是负责人（`deciderOf`）。
 * 它不出现在会话列表里：发起时在两位拍板人的私聊里落 `negotiation.started`，界面为协商卡片，
 * 卡片经本会话的事件展示每一步。状态存 `conversations.negotiation`，每一步与结束各落一条事件。
 *
 * 判定规则（假设 4、C4 第 4 步）只在本文件的 `judgeStep` 与 `agreeProblem`：
 * - 一方以 agree 回应另一方最近提出的 proposal，且二者深度相等 → agreed；
 * - 任一方 reject → rejected；
 * - 步数达到上限 → exhausted；
 * - need_owner → waiting_owner：经 `escalateToOwner` 给该分身的本人建 decision 待办，
 *   本人答复后由调度器恢复同一分身继续。
 */
import {
	DecisionResolutionSchema,
	type Event,
	NEGOTIATION_MAX_STEPS,
	type NEGOTIATION_OUTCOMES,
	type NEGOTIATION_STATUSES,
	type NegotiationState,
	NegotiationStateSchema,
	type WorkItem,
} from "@orgos/protocol";
import { asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import {
	conversationMembers,
	conversations,
	events,
	principals,
	workItems,
} from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { badRequest, notFound } from "@/lib/errors";
import { toEvent, toWorkItem } from "@/lib/serialize";
import { enqueueMemoryJob } from "@/memory/queue";
import {
	postAgentMessage,
	requireAgentPrincipal,
} from "@/services/agent-events";
import { openDm } from "@/services/conversations";
import { transactWithEvents } from "@/services/events";
import { insertConversation, mainTopicOf } from "@/services/topics";
import { deciderOf } from "@/services/units";
import {
	createWorkItem,
	escalateToOwner,
	notifyWorkItem,
} from "@/services/work-items";

type ConversationRow = typeof conversations.$inferSelect;
type AgentRow = PrincipalRow & { ownerId: string };

export type NegotiationOutcome = (typeof NEGOTIATION_OUTCOMES)[number];
export type NegotiationReply = {
	status: (typeof NEGOTIATION_STATUSES)[number];
	message: string;
	proposal?: unknown;
};
export type StepEvent = Extract<Event, { type: "negotiation.step" }>;

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

/** 协商的一方：分身的本人（人或单元）。 */
async function requireSide(s: Scoped, id: string): Promise<PrincipalRow> {
	const row = await s.first(principals, eq(principals.id, id));
	if (!row || (row.kind !== "human" && row.kind !== "unit"))
		throw notFound("找不到此人");
	return row;
}

/**
 * 双方拍板人（人是本人，单元是负责人）的私聊（没有则新建，含双方分身）：协商卡片、上报与确认落在这里。
 */
async function deciderDm(
	s: Scoped,
	initiatorOwnerId: string,
	responderOwnerId: string,
): Promise<string> {
	const a = await deciderOf(s, initiatorOwnerId);
	const b = await deciderOf(s, responderOwnerId);
	const { conversation } = await openDm(s, a, b.id);
	return conversation.id;
}

/** JSON 值的深度相等：对象不看键的顺序，数组看顺序。 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((x, i) => deepEqual(x, b[i]))
		);
	}
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	const rb = b as Record<string, unknown>;
	return (
		ka.length === kb.length &&
		ka.every(
			(k) =>
				Object.hasOwn(rb, k) &&
				deepEqual((a as Record<string, unknown>)[k], rb[k]),
		)
	);
}

/**
 * agree 是否成立：必须回应另一方最近提出的 proposal，且 proposal 与之深度相等。
 * 成立返回 null，否则返回原因（给模型看的纠正提示）。
 */
export function agreeProblem(
	state: NegotiationState,
	agentId: string,
	proposal: unknown,
): string | null {
	if (state.lastProposal === undefined || state.lastProposalBy === undefined)
		return "还没有人提出过 proposal，不能 agree；请用 continue 提出方案";
	if (state.lastProposalBy === agentId)
		return "最近的 proposal 是你自己提的，不能 agree 自己的方案；等对方回应，或用 continue 重申 / 修改方案";
	if (!deepEqual(proposal, state.lastProposal))
		return `agree 必须原样带上对方最近的 proposal：${JSON.stringify(state.lastProposal)}；想改方案请用 continue`;
	return null;
}

/**
 * 判定一步（纯函数）：返回推进后的状态与结果（未结束为 null）。
 * 不成立的 agree 带来的 proposal 视为新的提议。
 */
export function judgeStep(
	state: NegotiationState,
	agentId: string,
	reply: NegotiationReply,
): { next: NegotiationState; outcome: NegotiationOutcome | null } {
	const agreed =
		reply.status === "agree" &&
		agreeProblem(state, agentId, reply.proposal) === null;
	const proposes = reply.proposal !== undefined && !agreed;
	const step = state.step + 1;
	const outcome: NegotiationOutcome | null = agreed
		? "agreed"
		: reply.status === "reject"
			? "rejected"
			: step >= state.maxSteps
				? "exhausted"
				: null;
	return {
		next: {
			...state,
			step,
			state: outcome
				? state.state
				: reply.status === "need_owner"
					? "waiting_owner"
					: "running",
			...(proposes
				? { lastProposal: reply.proposal, lastProposalBy: agentId }
				: {}),
		},
		outcome,
	};
}

/** 协商的当前状态（不存在 → 404）。 */
export async function negotiationStateOf(
	s: Scoped,
	conversationId: string,
): Promise<NegotiationState> {
	return (await requireNegotiation(s, conversationId)).state;
}

export const SAME_DECIDER_TEXT = "协商双方由同一个人拍板，不需要协商";

/**
 * 建协商会话：发起方与应答方的代理为成员，双方拍板人（人是本人，单元是负责人）为 observer；
 * 同一事务里在两位拍板人的私聊落 `negotiation.started`（actor 为发起方代理）。
 */
export async function startNegotiation(
	s: Scoped,
	input: {
		initiatorAgentId: string;
		responderAgentId: string;
		goal: string;
		title: string;
		/** 发起方本人让分身去协商的会话与话题。 */
		originConversationId?: string;
		originTopicId?: string;
		at?: Date;
	},
): Promise<ConversationRow> {
	const initiator = await requireAgentPrincipal(s, input.initiatorAgentId);
	const responder = await requireAgentPrincipal(s, input.responderAgentId);
	if (initiator.ownerId === responder.ownerId) {
		throw badRequest("协商双方必须属于不同的人");
	}
	const initiatorDecider = await deciderOf(s, initiator.ownerId);
	const responderDecider = await deciderOf(s, responder.ownerId);
	if (initiatorDecider.id === responderDecider.id) {
		throw badRequest(SAME_DECIDER_TEXT);
	}
	const dmId = await deciderDm(s, initiator.ownerId, responder.ownerId);
	// 协商卡片：发起在两人私聊的某个话题里就落在那里，否则落在私聊主线。
	const cardTopicId =
		input.originConversationId === dmId && input.originTopicId
			? input.originTopicId
			: (await mainTopicOf(s, dmId)).id;
	const state: NegotiationState = {
		initiatorAgentId: initiator.id,
		responderAgentId: responder.id,
		goal: input.goal,
		step: 0,
		maxSteps: NEGOTIATION_MAX_STEPS,
		state: "running",
		cardTopicId,
		...(input.originConversationId
			? { originConversationId: input.originConversationId }
			: {}),
		...(input.originTopicId ? { originTopicId: input.originTopicId } : {}),
	};
	return transactWithEvents(s, async (tx, append) => {
		const { conversation: row } = await insertConversation(tx, {
			kind: "negotiation",
			title: input.title,
			createdBy: initiator.id,
			negotiation: state,
			...(input.at ? { createdAt: input.at } : {}),
		});
		const members = [
			{ principalId: initiator.id, role: "member" as const },
			{ principalId: responder.id, role: "member" as const },
			{ principalId: initiatorDecider.id, role: "observer" as const },
			{ principalId: responderDecider.id, role: "observer" as const },
		];
		for (const m of members) {
			await tx.insert(conversationMembers, { conversationId: row.id, ...m });
		}
		await append({
			conversationId: dmId,
			topicId: cardTopicId,
			actorId: initiator.id,
			onBehalfOfId: initiator.ownerId,
			type: "negotiation.started",
			payload: { negotiationConversationId: row.id, goal: input.goal },
			at: input.at,
		});
		return row;
	});
}

/**
 * 协商的一步：落 `negotiation.step`，按 `judgeStep` 推进状态。
 * 不负责结束与上报——由 `recordNegotiationReply`（或回放历史的演示数据）按返回的结果处理。
 */
export async function appendNegotiationStep(
	s: Scoped,
	conversationId: string,
	agentId: string,
	reply: NegotiationReply,
	at?: Date,
): Promise<{
	state: NegotiationState;
	outcome: NegotiationOutcome | null;
	event: Event;
}> {
	const agent = await requireAgentPrincipal(s, agentId);
	const { state } = await requireNegotiation(s, conversationId);
	if (state.state === "ended") throw badRequest("协商已结束");
	if (![state.initiatorAgentId, state.responderAgentId].includes(agent.id)) {
		throw notFound("协商不存在");
	}
	const { next, outcome } = judgeStep(state, agent.id, reply);
	const main = await mainTopicOf(s, conversationId);
	const event = await transactWithEvents(s, async (tx, append) => {
		const event = await append({
			conversationId,
			topicId: main.id,
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
		return event;
	});
	return { state: next, outcome, event };
}

const CONFIRMATION_MATTER_CHARS = 40;

function headOf(text: string, chars: number): string {
	const all = Array.from(text);
	return `${all.slice(0, chars).join("")}${all.length > chars ? "…" : ""}`;
}

/** proposal 的一句话写法：值都是简单类型的对象取各值，其余用 JSON。 */
export function describeProposal(proposal: unknown): string {
	if (proposal && typeof proposal === "object" && !Array.isArray(proposal)) {
		const values = Object.values(proposal);
		if (
			values.length > 0 &&
			values.every((v) => ["string", "number", "boolean"].includes(typeof v))
		)
			return values.join("，");
	}
	return JSON.stringify(proposal);
}

function summaryOf(
	outcome: NegotiationOutcome,
	state: NegotiationState,
	other: string,
	last: StepEvent | undefined,
): string {
	switch (outcome) {
		case "agreed":
			return `和${other}的分身谈妥了：${describeProposal(state.lastProposal)}。等你和${other}都确认后就算定下来，确认入口在待办和你们的私聊里。`;
		case "rejected":
			return `和${other}的分身没谈成${last ? `：${last.payload.message}` : "。"}`;
		case "exhausted":
			return `和${other}的分身来回 ${state.maxSteps} 步还没谈拢，我先停在这里${
				state.lastProposal === undefined
					? "。"
					: `，最后的方案是：${describeProposal(state.lastProposal)}。`
			}你可以直接和${other}聊。`;
	}
}

async function stepsOf(s: Scoped, conversationId: string) {
	const rows = await s.executor
		.select()
		.from(events)
		.where(
			s.where(
				events,
				eq(events.conversationId, conversationId),
				eq(events.type, "negotiation.step"),
			),
		)
		.orderBy(asc(events.seq));
	return rows
		.map(toEvent)
		.filter((e): e is StepEvent => e.type === "negotiation.step");
}

/**
 * 结束协商：落 `negotiation.ended`（actor 为发起方代理），并排一个 resolution 作业把结果写成 decision 记忆。
 * 结果为 agreed 时给双方拍板人
 * 各建一条 confirmation 待办，提问人为对方的代理，关联两人的私聊（协商卡片所在处），
 * 提交后推给各自的拍板人。协商由本人在某个会话里发起时，发起方分身在那里回一句结果摘要。
 */
export async function endNegotiation(
	s: Scoped,
	conversationId: string,
	outcome: NegotiationOutcome,
	at?: Date,
): Promise<WorkItem[]> {
	const { state } = await requireNegotiation(s, conversationId);
	if (state.state === "ended") throw badRequest("协商已结束");
	const initiator = await requireAgentPrincipal(s, state.initiatorAgentId);
	const responder = await requireAgentPrincipal(s, state.responderAgentId);
	const proposal = state.lastProposal;
	const dmId = await deciderDm(s, initiator.ownerId, responder.ownerId);
	const main = await mainTopicOf(s, conversationId);
	const items = await transactWithEvents(s, async (tx, append) => {
		const ended = await append({
			conversationId,
			topicId: main.id,
			actorId: initiator.id,
			onBehalfOfId: initiator.ownerId,
			type: "negotiation.ended",
			payload: {
				outcome,
				...(proposal === undefined ? {} : { proposal }),
			},
			at,
		});
		await enqueueMemoryJob(tx, {
			topicId: main.id,
			trigger: "resolution",
			eventId: ended.id,
		});
		await saveState(tx, conversationId, { ...state, state: "ended" });
		if (outcome !== "agreed") return [];
		const sides = new Map(
			await Promise.all(
				[initiator.ownerId, responder.ownerId].map(
					async (id) => [id, await requireSide(tx, id)] as const,
				),
			),
		);
		const matter = headOf(
			describeProposal(proposal),
			CONFIRMATION_MATTER_CHARS,
		);
		const items: WorkItem[] = [];
		for (const [self, other] of [
			[initiator, responder],
			[responder, initiator],
		] as const) {
			const otherName = sides.get(other.ownerId)?.displayName ?? "对方";
			items.push(
				await createWorkItem(tx, {
					kind: "confirmation",
					payload: { negotiationConversationId: conversationId, proposal },
					title: `确认与${otherName}的约定：${matter}`,
					body: `${other.displayName}与${self.displayName}已谈妥：${describeProposal(proposal)}`,
					ownerId: (await deciderOf(tx, self.ownerId)).id,
					requesterId: other.id,
					conversationId: dmId,
				}),
			);
		}
		return items;
	});
	for (const item of items) notifyWorkItem(item);
	if (state.originConversationId) {
		const other = await requireSide(s, responder.ownerId);
		const last = (await stepsOf(s, conversationId)).at(-1);
		await postAgentMessage(
			s,
			initiator.id,
			{
				conversationId: state.originConversationId,
				...(state.originTopicId ? { topicId: state.originTopicId } : {}),
			},
			summaryOf(outcome, state, other.displayName, last),
		);
	}
	return items;
}

/**
 * 分身的一步回应（协商驱动的唯一入口）：落一步并判定；结束则经 `endNegotiation` 收尾；
 * need_owner 则经 `escalateToOwner` 给该分身的拍板人建 decision 待办——卡片落在两位拍板人的私聊里，
 * 提问人为对方的分身。返回推进后的状态。
 */
export async function recordNegotiationReply(
	s: Scoped,
	conversationId: string,
	agentId: string,
	reply: NegotiationReply,
): Promise<NegotiationState> {
	const { state, outcome, event } = await appendNegotiationStep(
		s,
		conversationId,
		agentId,
		reply,
	);
	if (outcome) {
		await endNegotiation(s, conversationId, outcome);
		return { ...state, state: "ended" };
	}
	if (state.state === "waiting_owner") {
		const agent = await requireAgentPrincipal(s, agentId);
		const other = await requireAgentPrincipal(s, counterpartOf(state, agentId));
		const dmId = await deciderDm(s, agent.ownerId, other.ownerId);
		const head = Array.from(state.goal).slice(0, 30).join("");
		await escalateToOwner(s, {
			agentId,
			conversationId: dmId,
			topicId: state.cardTopicId ?? (await mainTopicOf(s, dmId)).id,
			requesterId: other.id,
			question: [
				`和${other.displayName}协商时需要你定：${reply.message}`,
				...(state.lastProposal === undefined
					? []
					: [`当前方案：${describeProposal(state.lastProposal)}`]),
			].join("\n"),
			title: `协商需要你定：${head}`,
			sourceEventId: event.id,
			negotiationConversationId: conversationId,
		});
	}
	return state;
}

export function counterpartOf(
	state: NegotiationState,
	agentId: string,
): string {
	return agentId === state.initiatorAgentId
		? state.responderAgentId
		: state.initiatorAgentId;
}

export const ORIGIN_MESSAGES_LIMIT = 8;

/** 协商中某个分身这一步所需的全部上下文。 */
export type NegotiationContext = {
	state: NegotiationState;
	role: "initiator" | "responder";
	counterpart: AgentRow;
	counterpartOwner: PrincipalRow;
	steps: StepEvent[];
	/** 发起方本人让分身去协商时的对话（仅发起方有）：说话人是本人或分身自己。 */
	request: { self: boolean; text: string }[];
	/** 本人对这个分身在本次协商里 need_owner 的答复。 */
	ownerAnswers: { question: string; declined: boolean; text?: string }[];
};

export async function negotiationContext(
	s: Scoped,
	conversationId: string,
	agentId: string,
): Promise<NegotiationContext> {
	const { row, state } = await requireNegotiation(s, conversationId);
	const self = await requireAgentPrincipal(s, agentId);
	const counterpart = await requireAgentPrincipal(
		s,
		counterpartOf(state, agentId),
	);
	const role = agentId === state.initiatorAgentId ? "initiator" : "responder";
	const request =
		role === "initiator" && state.originConversationId
			? await originMessages(
					s,
					state.originConversationId,
					state.originTopicId ?? null,
					row.createdAt,
				)
			: [];
	const answers = await s.executor
		.select()
		.from(workItems)
		.where(
			s.where(
				workItems,
				eq(workItems.ownerId, (await deciderOf(s, self.ownerId)).id),
				eq(workItems.kind, "decision"),
				eq(workItems.status, "done"),
				sql`${workItems.payload}->>'negotiationConversationId' = ${conversationId}`,
			),
		)
		.orderBy(asc(workItems.createdAt));
	return {
		state,
		role,
		counterpart,
		counterpartOwner: await requireSide(s, counterpart.ownerId),
		steps: await stepsOf(s, conversationId),
		request: request.map((e) => ({
			self: e.actorId === self.id,
			text: e.payload.text,
		})),
		ownerAnswers: answers.map(toWorkItem).flatMap((item) => {
			if (item.kind !== "decision") return [];
			const r = DecisionResolutionSchema.safeParse(item.resolution);
			if (!r.success) return [];
			return [
				{
					question: item.payload.question,
					declined: r.data.action === "decline",
					...(r.data.text ? { text: r.data.text } : {}),
				},
			];
		}),
	};
}

type MessageEvent = Extract<Event, { type: "message.posted" }>;

/**
 * 发起方本人让分身去协商时的那段对话：协商开始前原话题里最近的消息，
 * 但不越过上一次从这里发起的协商（那是另一件事）。
 */
async function originMessages(
	s: Scoped,
	conversationId: string,
	topicId: string | null,
	until: Date,
): Promise<MessageEvent[]> {
	const [previous] = await s.executor
		.select({ seq: events.seq })
		.from(events)
		.where(
			s.where(
				events,
				eq(events.conversationId, conversationId),
				topicId ? eq(events.topicId, topicId) : undefined,
				eq(events.type, "agent.action"),
				sql`${events.payload}->>'tool' = 'negotiate'`,
				sql`(${events.payload}->>'ok')::boolean`,
				lte(events.createdAt, until),
			),
		)
		.orderBy(desc(events.seq))
		.limit(1);
	const rows = await s.executor
		.select()
		.from(events)
		.where(
			s.where(
				events,
				eq(events.conversationId, conversationId),
				topicId ? eq(events.topicId, topicId) : undefined,
				eq(events.type, "message.posted"),
				lte(events.createdAt, until),
				previous?.seq ? gt(events.seq, previous.seq) : undefined,
			),
		)
		.orderBy(desc(events.seq))
		.limit(ORIGIN_MESSAGES_LIMIT);
	return rows
		.reverse()
		.map(toEvent)
		.filter((e): e is MessageEvent => e.type === "message.posted");
}
