/**
 * 代理运行循环：组装系统提示 + 最近 40 条会话消息 → 调模型 → 有工具调用则执行并继续 →
 * 无工具调用时把文本作为 message.posted 落库。单次运行最多 8 次模型调用。
 * 结束型工具（escalate_to_owner、negotiation_reply）执行后本次运行随即结束，不再产生回复。
 *
 * 协商会话里：上下文是协商的步骤序列与协议说明；不发消息——以 negotiation_reply 结束时交回
 * 这一步的回应，否则把最终文本交回，由调度器视为 continue。
 *
 * 直接被触发的运行（depth 0）经 draft / status 帧向会话成员直播；被转交的运行（depth ≥ 1）
 * 不发帧、不发消息，最终文本交回转交者，它的工具动作记在转交链顶端的代理名下。
 * 会话被打断（新的人类消息）时在步边界停止，且不再发出这一步之后的回复；被中止时立即停止。
 */
import { randomUUID } from "node:crypto";
import type { Agent } from "@orgos/protocol";
import { desc, eq } from "drizzle-orm";
import { framesFor, silentFrames } from "@/agent/frames";
import {
	type ChatMessage,
	LlmAbortedError,
	type LlmClient,
	type RunTrigger,
} from "@/agent/llm-types";
import {
	buildNegotiationPrompt,
	negotiationMessages,
} from "@/agent/negotiation-prompt";
import { buildSystemPrompt, historyMessages } from "@/agent/prompt";
import {
	HISTORY_LIMIT,
	LIMIT_SUMMARY,
	MAX_MODEL_CALLS,
	type RunSession,
} from "@/agent/session";
import {
	availableTools,
	executeToolCall,
	toolLabel,
	toToolSpec,
} from "@/agent/tools";
import type { ToolScope } from "@/agent/tools/tool";
import type { ActingFor } from "@/agent/triggers";
import { conversations, events, principals } from "@/db/schema";
import type { Scoped } from "@/db/scope";
import { toEvent } from "@/lib/serialize";
import { postAgentMessage, recordAgentAction } from "@/services/agent-events";
import { findAgent } from "@/services/agents";
import { memberPrincipals } from "@/services/conversations";
import {
	type NegotiationReply,
	negotiationContext,
} from "@/services/negotiations";

export const STEP_LIMIT_TEXT = "这件事步骤太多，我先停在这里。";
export const MODEL_UNAVAILABLE_TEXT = "模型暂时不可用，请稍后再试。";

export type RunInput = {
	s: Scoped;
	agentId: string;
	conversationId: string;
	actingFor: ActingFor;
	/** 触发文本与其中的 @；代理身份与会话类型由循环补齐。 */
	trigger: Omit<RunTrigger, "agent" | "conversationKind">;
	/** 引起本次运行的人类消息。 */
	triggerEventId?: number;
	session: RunSession;
	llm: LlmClient;
	/** 转交：谁转交来的、动作记在谁名下、当前深度。 */
	delegation?: { from: Agent; recorderId: string; depth: number };
	/** negotiate 建好协商会话后，交给调度器驱动。 */
	startNegotiation: (negotiationConversationId: string) => void;
};

export type RunResult = {
	outcome:
		| "posted"
		| "returned"
		| "passed"
		| "ended"
		| "stopped"
		| "failed"
		| "limit";
	/** 转交运行或协商中的一步交回的文本。 */
	text?: string;
	/** 协商中以 negotiation_reply 结束时的回应。 */
	reply?: NegotiationReply;
};

async function recentEvents(s: Scoped, conversationId: string) {
	const rows = await s.executor
		.select()
		.from(events)
		.where(s.where(events, eq(events.conversationId, conversationId)))
		.orderBy(desc(events.seq))
		.limit(HISTORY_LIMIT);
	return rows.reverse().map(toEvent);
}

export async function runAgent(input: RunInput): Promise<RunResult> {
	const { s, session, llm, actingFor, delegation } = input;
	const agent = await findAgent(s, { id: input.agentId });
	const ownerId = agent?.principal.ownerId;
	const owner = ownerId
		? await s.first(principals, eq(principals.id, ownerId))
		: undefined;
	const conversation = await s.first(
		conversations,
		eq(conversations.id, input.conversationId),
	);
	if (!agent || !owner || !conversation) return { outcome: "stopped" };

	const depth = delegation?.depth ?? 0;
	const visible = depth === 0;
	const negotiation = conversation.kind === "negotiation";
	/** 直接被触发、且不在协商会话里：最终文本作为消息发出。 */
	const posts = visible && !negotiation;
	const agentId = agent.principal.id;
	const recorderId = delegation?.recorderId ?? agentId;
	const members = await memberPrincipals(s, conversation.id);
	const nameOf = (id: string) => members.get(id)?.displayName ?? "同事";
	const frames = visible
		? framesFor([...members.keys()], {
				conversationId: conversation.id,
				agentId,
				runId: randomUUID(),
			})
		: silentFrames;
	const act = (tool: string, summary: string, ok: boolean) =>
		recordAgentAction(s, recorderId, conversation.id, {
			tool,
			summary: visible ? summary : `${agent.principal.displayName}：${summary}`,
			ok,
		});

	const scope: ToolScope = {
		s,
		agent,
		owner,
		conversation: { id: conversation.id, kind: conversation.kind },
		actingFor,
		depth,
		triggerEventId: visible ? (input.triggerEventId ?? null) : null,
		session,
		async delegate(target, task) {
			const result = await runAgent({
				...input,
				agentId: target.principal.id,
				trigger: { text: task, mentions: [] },
				delegation: { from: agent, recorderId, depth: depth + 1 },
			});
			return result.text ?? "没有结果";
		},
		startNegotiation: input.startNegotiation,
	};
	const tools = availableTools(scope);
	const ctx =
		negotiation && !delegation
			? await negotiationContext(s, conversation.id, agentId)
			: null;
	const system = ctx
		? buildNegotiationPrompt({ scope, tools, ctx })
		: buildSystemPrompt({
				scope,
				tools,
				requesterName:
					actingFor.kind === "other" ? nameOf(actingFor.principalId) : null,
				conversationTitle: conversation.title,
				delegatedBy: delegation?.from ?? null,
				resume: input.trigger.resume ?? null,
			});
	const messages: ChatMessage[] = [
		{ role: "system", content: system },
		...(delegation
			? [
					{
						role: "user" as const,
						content: `【${delegation.from.principal.displayName}转交】${input.trigger.text}`,
					},
				]
			: ctx
				? negotiationMessages(ctx, agentId, nameOf, owner.displayName)
				: historyMessages(
						await recentEvents(s, conversation.id),
						agentId,
						nameOf,
					)),
	];
	const trigger: RunTrigger = {
		...input.trigger,
		agent: { id: agentId, handle: agent.principal.handle },
		conversationKind: conversation.kind,
		...(ctx
			? {
					negotiation: {
						role: ctx.role,
						goal: ctx.state.goal,
						lastProposal: ctx.state.lastProposal,
						lastProposalMine: ctx.state.lastProposalBy === agentId,
						ownerAnswered: ctx.ownerAnswers.length > 0,
					},
				}
			: {}),
	};
	const meta = {
		tenantId: s.tenantId,
		agentId,
		onBehalfOfId: actingFor.kind === "other" ? actingFor.principalId : owner.id,
		conversationId: conversation.id,
		model: agent.model,
	};

	try {
		for (let call = 0; call < MAX_MODEL_CALLS; call++) {
			if (session.stopped) return { outcome: "stopped" };
			frames.status("thinking");
			let res: Awaited<ReturnType<LlmClient["complete"]>>;
			try {
				res = await llm.complete({
					messages,
					tools: tools.map(toToolSpec),
					meta,
					trigger,
					signal: session.signal,
					onDelta: frames.draft,
				});
			} catch (e) {
				if (e instanceof LlmAbortedError || session.signal.aborted)
					return { outcome: "stopped" };
				console.error("[agent] 模型调用失败", e);
				await act(
					"model",
					e instanceof Error ? e.message : "模型暂时不可用",
					false,
				);
				if (posts)
					await postAgentMessage(
						s,
						agentId,
						conversation.id,
						MODEL_UNAVAILABLE_TEXT,
					);
				return { outcome: "failed", text: MODEL_UNAVAILABLE_TEXT };
			}
			if (session.stopped) return { outcome: "stopped" };

			if (res.toolCalls.length === 0) {
				const text = res.text.trim() || "（没有可说的）";
				if (!posts) return { outcome: "returned", text };
				await postAgentMessage(s, agentId, conversation.id, text);
				return { outcome: "posted" };
			}

			messages.push({
				role: "assistant",
				content: res.text || null,
				tool_calls: res.toolCalls.map((c) => ({
					id: c.id,
					type: "function",
					function: { name: c.name, arguments: c.arguments },
				})),
			});
			for (const toolCall of res.toolCalls) {
				if (session.stopped) return { outcome: "stopped" };
				const label = toolLabel(toolCall.name);
				if (label) frames.status("tool", label);
				const out = await executeToolCall(toolCall, scope);
				if (out.pass) return { outcome: "passed" };
				await act(toolCall.name, out.summary, out.ok);
				if (out.end)
					return {
						outcome: "ended",
						...(out.reply ? { reply: out.reply } : {}),
					};
				messages.push({
					role: "tool",
					tool_call_id: toolCall.id,
					content: out.result,
				});
			}
		}
		if (posts)
			await postAgentMessage(s, agentId, conversation.id, STEP_LIMIT_TEXT);
		await act("system", LIMIT_SUMMARY.modelCalls, false);
		return { outcome: "limit", text: STEP_LIMIT_TEXT };
	} finally {
		frames.status("idle");
	}
}
