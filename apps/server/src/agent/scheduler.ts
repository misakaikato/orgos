/**
 * 调度：一条人类消息落库后决定谁来回应，并保证同一会话同一时刻只有一轮在跑。
 *
 * - 谁该回应只问 `@/agent/triggers`：私聊用 agentsToTrigger，群聊用 groupRound 给出的顺序；
 * - 新的人类消息到来：正在跑的运行在步边界停止，然后从新消息开始新一轮（排队中的旧轮直接作废）；
 * - `stop`：立即中止（取消进行中的模型调用），不再开始排队中的轮次；
 * - 群聊轮次（假设 5）：被 @ 的先说，其余按入群顺序各轮到一次（pass 无声）；有人发言才进下一轮，
 *   只点听到新内容的代理；最多 4 轮。第 2 轮起的每次运行、每次转交都算一次交接，累计到 8 次停止；
 * - 因上限停止时落一条 agent.action{tool:'system', ok:false}，summary 写明是哪个上限。
 */
import type { Event } from "@orgos/protocol";
import { desc, eq, gt, ne } from "drizzle-orm";
import { getLlmClient } from "@/agent/llm";
import type { LlmClient } from "@/agent/llm-types";
import { runAgent } from "@/agent/loop";
import { LIMIT_SUMMARY, MAX_ROUNDS, RunSession } from "@/agent/session";
import {
	agentsToTrigger,
	groupRound,
	type Trigger,
	type TriggerMessage,
} from "@/agent/triggers";
import { conversations, events } from "@/db/schema";
import type { Scoped } from "@/db/scope";
import { toEvent } from "@/lib/serialize";
import { recordAgentAction } from "@/services/agent-events";
import { triggerConversationOf } from "@/services/conversations";

export type MessageEvent = Extract<Event, { type: "message.posted" }>;

type ConversationState = {
	/** 每条人类消息与每次 stop 都会推进；排队中的轮次开始前比对，过期即作废。 */
	gen: number;
	tail: Promise<void>;
	current: RunSession | null;
};

export type SchedulerDeps = { llm: () => LlmClient };

type ChainInput = {
	s: Scoped;
	conversationId: string;
	event: MessageEvent;
	session: RunSession;
	llm: LlmClient;
};

export class Scheduler {
	private readonly states = new Map<string, ConversationState>();

	constructor(private readonly deps: SchedulerDeps = { llm: getLlmClient }) {}

	private stateOf(conversationId: string): ConversationState {
		let st = this.states.get(conversationId);
		if (!st) {
			st = { gen: 0, tail: Promise.resolve(), current: null };
			this.states.set(conversationId, st);
		}
		return st;
	}

	/**
	 * 人类消息落库之后调用：打断当前运行，排队从这条消息开始新一轮。
	 * 返回这一轮结束的 promise（调用方不必等待）。
	 */
	onHumanMessage(s: Scoped, event: MessageEvent): Promise<void> {
		const conversationId = event.conversationId;
		if (!conversationId) return Promise.resolve();
		const st = this.stateOf(conversationId);
		const gen = ++st.gen;
		st.current?.interrupt();
		st.tail = st.tail.then(async () => {
			if (gen !== st.gen) return;
			const session = new RunSession();
			st.current = session;
			try {
				await this.chain({
					s,
					conversationId,
					event,
					session,
					llm: this.deps.llm(),
				});
			} catch (e) {
				console.error("[agent] 调度出错", e);
			} finally {
				st.current = null;
				if (gen === st.gen) this.states.delete(conversationId);
			}
		});
		return st.tail;
	}

	/** POST /stop：立即中止正在跑的运行，排队中的轮次不再开始。 */
	stop(conversationId: string): void {
		const st = this.states.get(conversationId);
		if (!st) return;
		st.gen += 1;
		st.current?.abort();
	}

	/** 该会话当前的轮次全部结束（测试与脚本用）。 */
	idle(conversationId: string): Promise<void> {
		return this.states.get(conversationId)?.tail ?? Promise.resolve();
	}

	private async chain(input: ChainInput): Promise<void> {
		const { s, conversationId, event, session } = input;
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
			await recordAgentAction(s, last, conversationId, {
				tool: "system",
				summary: LIMIT_SUMMARY[session.limitHit],
				ok: false,
			});
		}
	}

	private run(input: ChainInput, t: Trigger, trigger: MessageEvent) {
		return runAgent({
			s: input.s,
			agentId: t.agentId,
			conversationId: input.conversationId,
			actingFor: t.actingFor,
			trigger: {
				text: trigger.payload.text,
				mentions: trigger.payload.mentions,
			},
			session: input.session,
			llm: input.llm,
		});
	}

	/** 群聊轮次；返回最后一个发言（或最后一个运行）的代理。 */
	private async rounds(
		input: ChainInput,
		order: Trigger[],
	): Promise<string | null> {
		const { s, conversationId, session } = input;
		const lastTurn = new Map<string, number>();
		let participants = order.map((t) => ({ t, heard: input.event }));
		let last: string | null = null;
		for (let round = 1; participants.length > 0; round++) {
			let spoke = false;
			for (const { t, heard } of participants) {
				if (session.stopped) return last;
				if (round > 1 && !session.takeHandoff()) return last ?? t.agentId;
				const res = await this.run(input, t, heard);
				lastTurn.set(t.agentId, await currentSeq(s, conversationId));
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
					conversationId,
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

async function currentSeq(s: Scoped, conversationId: string): Promise<number> {
	const row = await s.first(
		conversations,
		eq(conversations.id, conversationId),
	);
	return row?.lastSeq ?? 0;
}

/** 某代理上次轮到之后，别人发的最新一条消息（没有则 null）。 */
async function newContentFor(
	s: Scoped,
	conversationId: string,
	agentId: string,
	afterSeq: number,
): Promise<MessageEvent | null> {
	const [row] = await s.executor
		.select()
		.from(events)
		.where(
			s.where(
				events,
				eq(events.conversationId, conversationId),
				eq(events.type, "message.posted"),
				ne(events.actorId, agentId),
				gt(events.seq, afterSeq),
			),
		)
		.orderBy(desc(events.seq))
		.limit(1);
	if (!row) return null;
	const event = toEvent(row);
	return event.type === "message.posted" ? event : null;
}

export const scheduler = new Scheduler();
