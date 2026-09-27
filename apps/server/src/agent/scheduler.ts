/**
 * 调度：一条人类消息落库后决定谁来回应，并保证同一话题同一时刻只有一轮在跑
 * （话题是上下文的边界：不同话题各自排队、互不打断）。
 *
 * - 谁该回应只问 `@/agent/triggers`：私聊用 agentsToTrigger，群聊用 groupRound 给出的顺序；
 * - 新的人类消息到来：该话题正在跑的运行在步边界停止，然后从新消息开始新一轮（排队中的旧轮直接作废）；
 * - `stop`：立即中止（取消进行中的模型调用），不再开始排队中的轮次；
 * - 上报被本人处理后，恢复上报的代理（resume）：排进上报卡片所在话题的队列，不被新的人类消息作废或打断；
 * - 群聊轮次（假设 5）：被 @ 的先说，其余按入群顺序各轮到一次（pass 无声）；有人发言才进下一轮，
 *   只点听到新内容的代理；最多 4 轮。第 2 轮起的每次运行、每次转交都算一次交接，累计到 8 次停止；
 * - 因上限停止时落一条 agent.action{tool:'system', ok:false}，summary 写明是哪个上限；
 * - 协商（C4）：negotiate 建好协商会话后，在该会话的队列里驱动两个分身轮流各走一步（发起方先），
 *   每步交给 `recordNegotiationReply` 判定，直到结束或等本人拍板；本人答复后恢复同一分身接着走；
 * - 外部助手不经运行循环：本人在与它的私聊里发的消息交给外部会话服务，进该话题的 ACP 会话。
 */
import {
	DecisionResolutionSchema,
	type Event,
	isExternalAgent,
	type WorkItem,
} from "@orgos/protocol";
import { desc, eq, gt, ne } from "drizzle-orm";
import { getLlmClient } from "@/agent/llm";
import type { LlmClient, RunTrigger } from "@/agent/llm-types";
import { type RunResult, runAgent } from "@/agent/loop";
import { LIMIT_SUMMARY, MAX_ROUNDS, RunSession } from "@/agent/session";
import {
	type ActingFor,
	actingFor,
	agentsToTrigger,
	groupRound,
	type Trigger,
	type TriggerMessage,
} from "@/agent/triggers";
import { conversations, events, principals } from "@/db/schema";
import type { Scoped } from "@/db/scope";
import { toEvent } from "@/lib/serialize";
import { recordAgentAction } from "@/services/agent-events";
import { findAgent } from "@/services/agents";
import { triggerConversationOf } from "@/services/conversations";
import { externalSessions } from "@/services/external-sessions";
import {
	counterpartOf,
	type NegotiationReply,
	negotiationStateOf,
	recordNegotiationReply,
} from "@/services/negotiations";
import { cardEventOf } from "@/services/work-items";

export type MessageEvent = Extract<Event, { type: "message.posted" }>;

type TopicState = {
	conversationId: string;
	/** 每条人类消息与每次 stop 都会推进；排队中的轮次开始前比对，过期即作废。 */
	gen: number;
	tail: Promise<void>;
	current: RunSession | null;
	/** 当前运行能否被新的人类消息打断（上报后恢复的运行不能：本人的答复必须送达）。 */
	interruptible: boolean;
	/** 排队与运行中的任务数；归零时释放该话题的状态。 */
	pending: number;
};

export type SchedulerDeps = { llm: () => LlmClient };

type ChainInput = {
	s: Scoped;
	conversationId: string;
	topicId: string;
	event: MessageEvent;
	session: RunSession;
	llm: LlmClient;
};

/** 恢复上报代理的运行所需的信息。 */
export type ResumeInput = {
	conversationId: string;
	topicId: string;
	agentId: string;
	/** 被处理的待办（运行记录的触发来源）。 */
	workItemId: string;
	actingFor: ActingFor;
	resume: NonNullable<RunTrigger["resume"]>;
};

export class Scheduler {
	/** 按话题（协商按协商会话）的队列。 */
	private readonly states = new Map<string, TopicState>();

	constructor(private readonly deps: SchedulerDeps = { llm: getLlmClient }) {}

	private stateOf(key: string, conversationId: string): TopicState {
		let st = this.states.get(key);
		if (!st) {
			st = {
				conversationId,
				gen: 0,
				tail: Promise.resolve(),
				current: null,
				interruptible: true,
				pending: 0,
			};
			this.states.set(key, st);
		}
		return st;
	}

	/**
	 * 把一个任务排进话题的队列：同一话题同一时刻只有一个任务在跑。
	 * `gen` 给定时，任务开始前若话题已被新的人类消息或 stop 推进则作废。
	 */
	private enqueue(
		key: string,
		conversationId: string,
		opts: { gen?: number; interruptible: boolean },
		job: (session: RunSession) => Promise<void>,
	): Promise<void> {
		const st = this.stateOf(key, conversationId);
		st.pending += 1;
		st.tail = st.tail.then(async () => {
			try {
				if (opts.gen !== undefined && opts.gen !== st.gen) return;
				const session = new RunSession();
				st.current = session;
				st.interruptible = opts.interruptible;
				await job(session);
			} catch (e) {
				console.error("[agent] 调度出错", e);
			} finally {
				st.current = null;
				st.pending -= 1;
				if (st.pending === 0) this.states.delete(key);
			}
		});
		return st.tail;
	}

	/**
	 * 人类消息落库之后调用：打断该话题的当前运行，排队从这条消息开始新一轮。
	 * 返回这一轮结束的 promise（调用方不必等待）。
	 */
	onHumanMessage(s: Scoped, event: MessageEvent): Promise<void> {
		const { conversationId, topicId } = event;
		if (!conversationId || !topicId) return Promise.resolve();
		const st = this.stateOf(topicId, conversationId);
		const gen = ++st.gen;
		if (st.interruptible) st.current?.interrupt();
		return this.enqueue(
			topicId,
			conversationId,
			{ gen, interruptible: true },
			(session) =>
				this.chain({
					s,
					conversationId,
					topicId,
					event,
					session,
					llm: this.deps.llm(),
				}),
		);
	}

	/**
	 * 本人答复（或暂不答复）了上报：以答复为触发，恢复当初上报的那个代理，
	 * 仍为原提问者办事，在同一会话里回复。排在该会话当前的运行之后，不会被作废或打断。
	 */
	resume(s: Scoped, input: ResumeInput): Promise<void> {
		return this.enqueue(
			input.topicId,
			input.conversationId,
			{ interruptible: false },
			async (session) => {
				await runAgent({
					s,
					agentId: input.agentId,
					conversationId: input.conversationId,
					topicId: input.topicId,
					actingFor: input.actingFor,
					trigger: {
						text: input.resume.answer,
						mentions: [],
						resume: input.resume,
					},
					triggerRef: `work_item:${input.workItemId}`,
					session,
					llm: this.deps.llm(),
					startNegotiation: (id) => void this.negotiate(s, id),
				});
			},
		);
	}

	/**
	 * 一条 decision 待办被本人处理后：找到当初上报的代理，仍为原提问者、在上报卡片所在的话题里恢复运行。
	 * 返回时恢复运行已排进队列（之后可用 idle 等它结束）。
	 */
	async onEscalationResolved(
		s: Scoped,
		item: Extract<WorkItem, { kind: "decision" }>,
	): Promise<void> {
		const resolution = DecisionResolutionSchema.safeParse(item.resolution);
		const card = await cardEventOf(s, item);
		if (!item.conversationId || !card || !resolution.success) return;
		const agent = await s.first(principals, eq(principals.id, card.actorId));
		if (!agent) return;
		const { action, text } = resolution.data;
		const negotiationId = item.payload.negotiationConversationId;
		if (negotiationId) {
			void this.negotiate(s, negotiationId, {
				agentId: agent.id,
				resume: {
					answer: text ?? "",
					...(action === "decline" ? { declined: true } : {}),
				},
			});
			return;
		}
		void this.resume(s, {
			conversationId: item.conversationId,
			topicId: card.topicId,
			agentId: agent.id,
			workItemId: item.id,
			actingFor: actingFor(agent, item.payload.askedById),
			resume: {
				answer: text ?? "",
				...(action === "decline" ? { declined: true } : {}),
			},
		});
	}

	/**
	 * 驱动一场协商：排进协商会话的队列，两个分身轮流各走一步，直到结束或等本人拍板。
	 * 不给 `from` 时从发起方开始（新协商）；给了则是本人答复后恢复那个分身。
	 * 一次运行没有以 negotiation_reply 结束时，视为 continue，message 取它的最终文本。
	 */
	negotiate(
		s: Scoped,
		negotiationId: string,
		from?: { agentId: string; resume: NonNullable<RunTrigger["resume"]> },
	): Promise<void> {
		return this.enqueue(
			negotiationId,
			negotiationId,
			{ interruptible: false },
			async (session) => {
				const state = await negotiationStateOf(s, negotiationId);
				if (state.state !== (from ? "waiting_owner" : "running")) return;
				if (!from && state.step > 0) return;
				let agentId = from?.agentId ?? state.initiatorAgentId;
				let trigger: RunTrigger["text"] = from?.resume.answer ?? state.goal;
				let resume = from?.resume;
				for (;;) {
					const res = await runAgent({
						s,
						agentId,
						conversationId: negotiationId,
						actingFor: { kind: "owner" },
						trigger: {
							text: trigger,
							mentions: [],
							...(resume ? { resume } : {}),
						},
						triggerRef: `negotiation:${negotiationId}`,
						session,
						llm: this.deps.llm(),
						startNegotiation: (id) => void this.negotiate(s, id),
					});
					if (res.outcome === "stopped") return;
					const reply: NegotiationReply = res.reply ?? {
						status: "continue",
						message: res.text ?? "",
					};
					const next = await recordNegotiationReply(
						s,
						negotiationId,
						agentId,
						reply,
					);
					if (next.state !== "running") return;
					agentId = counterpartOf(next, agentId);
					trigger = reply.message;
					resume = undefined;
				}
			},
		);
	}

	/** POST /stop：立即中止会话（或其中某个话题）正在跑的运行，排队中的轮次不再开始。 */
	stop(conversationId: string, topicId?: string): void {
		for (const [key, st] of this.states) {
			if (st.conversationId !== conversationId) continue;
			if (topicId && key !== topicId) continue;
			st.gen += 1;
			st.current?.abort();
		}
	}

	/** 某会话（或话题）当前的轮次全部结束（测试与脚本用）。 */
	async idle(id: string): Promise<void> {
		for (;;) {
			const tails = [...this.states.entries()]
				.filter(([key, st]) => key === id || st.conversationId === id)
				.map(([, st]) => st.tail);
			if (tails.length === 0) return;
			await Promise.all(tails);
		}
	}

	private async chain(input: ChainInput): Promise<void> {
		const { s, conversationId, topicId, event, session } = input;
		const conversation = await s.first(
			conversations,
			eq(conversations.id, conversationId),
		);
		if (!conversation) return;
		const conv = await triggerConversationOf(s, conversation);
		const msg: TriggerMessage = {
			actorId: event.actorId,
			mentions: event.payload.mentions,
			askTwin: event.payload.askTwin,
		};
		let last: string | null = null;
		if (conversation.kind === "group") {
			last = await this.rounds(input, groupRound(conv, msg));
		} else {
			for (const t of agentsToTrigger(conv, msg)) {
				if (session.stopped) break;
				await this.run(input, t, event);
				last = t.agentId;
			}
		}
		if (session.limitHit && last && !session.signal.aborted) {
			await recordAgentAction(
				s,
				last,
				{ conversationId, topicId },
				{
					tool: "system",
					summary: LIMIT_SUMMARY[session.limitHit],
					ok: false,
				},
			);
		}
	}

	private async run(
		input: ChainInput,
		t: Trigger,
		trigger: MessageEvent,
	): Promise<RunResult> {
		const agent = await findAgent(input.s, { id: t.agentId });
		if (agent && isExternalAgent(agent)) {
			await externalSessions.onOwnerMessage(
				input.s,
				agent,
				{ conversationId: input.conversationId, topicId: input.topicId },
				{
					id: trigger.id,
					actorId: trigger.actorId,
					text: trigger.payload.text,
				},
			);
			return { outcome: "ended" };
		}
		return runAgent({
			s: input.s,
			agentId: t.agentId,
			conversationId: input.conversationId,
			topicId: input.topicId,
			actingFor: t.actingFor,
			trigger: {
				text: trigger.payload.text,
				mentions: trigger.payload.mentions,
			},
			triggerRef: `event:${trigger.id}`,
			triggerEventId: trigger.id,
			session: input.session,
			llm: input.llm,
			startNegotiation: (id) => void this.negotiate(input.s, id),
		});
	}

	/** 群聊轮次；返回最后一个发言（或最后一个运行）的代理。 */
	private async rounds(
		input: ChainInput,
		order: Trigger[],
	): Promise<string | null> {
		const { s, topicId, session } = input;
		const lastTurn = new Map<string, number>();
		let participants = order.map((t) => ({ t, heard: input.event }));
		let last: string | null = null;
		for (let round = 1; participants.length > 0; round++) {
			let spoke = false;
			for (const { t, heard } of participants) {
				if (session.stopped) return last;
				if (round > 1 && !session.takeHandoff()) return last ?? t.agentId;
				const res = await this.run(input, t, heard);
				lastTurn.set(t.agentId, await latestEventId(s, topicId));
				if (res.outcome === "posted") {
					spoke = true;
					last = t.agentId;
				}
			}
			if (!spoke || session.stopped) return last;
			const next: typeof participants = [];
			for (const t of order) {
				const heard = await newContentFor(
					s,
					topicId,
					t.agentId,
					lastTurn.get(t.agentId) ?? 0,
				);
				if (heard) next.push({ t, heard });
			}
			if (next.length > 0 && round >= MAX_ROUNDS) {
				session.limitHit = "rounds";
				return last;
			}
			participants = next;
		}
		return last;
	}
}

/** 话题里最新一条事件的 id（没有则 0）。 */
async function latestEventId(s: Scoped, topicId: string): Promise<number> {
	const [row] = await s.executor
		.select({ id: events.id })
		.from(events)
		.where(s.where(events, eq(events.topicId, topicId)))
		.orderBy(desc(events.id))
		.limit(1);
	return row?.id ?? 0;
}

/** 某代理上次轮到之后，话题里别人发的最新一条消息（没有则 null）。 */
async function newContentFor(
	s: Scoped,
	topicId: string,
	agentId: string,
	afterId: number,
): Promise<MessageEvent | null> {
	const [row] = await s.executor
		.select()
		.from(events)
		.where(
			s.where(
				events,
				eq(events.topicId, topicId),
				eq(events.type, "message.posted"),
				ne(events.actorId, agentId),
				gt(events.id, afterId),
			),
		)
		.orderBy(desc(events.id))
		.limit(1);
	if (!row) return null;
	const event = toEvent(row);
	return event.type === "message.posted" ? event : null;
}

export const scheduler = new Scheduler();
