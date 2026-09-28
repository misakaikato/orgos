/**
 * 代理运行循环：组装系统提示 + 当前话题的历史（必要时先压缩）+ 近期工作简报 → 调模型 →
 * 有工具调用则执行并继续 → 无工具调用时把文本作为 message.posted 落在当前话题（正文里的 `[M:…]`
 * 引用解析为依据后剥离；替本人回答他人时记下提问人，供代答记录）。
 * 为他人办事时，最终回复若声称已转交本人而本轮没有调用 escalate_to_owner，先纠正一次（计入模型调用上限），
 * 仍如此则照常落回复并记一条未上报的系统动作。
 * 单次运行最多 8 次模型调用。结束型工具（escalate_to_owner、negotiation_reply）执行后本次运行随即结束；
 * post_html 发出的 html 消息就是这次的回复，同样随即结束。结束型工具所在那一步里随调用写的文字一律不发出。
 *
 * 每次运行写一条运行记录（`@/services/runs`）：开始、结束、失败、中止、被打断；模型调用带 runId 记账。
 *
 * 协商会话里：上下文是协商的步骤序列与协议说明；不发消息——以 negotiation_reply 结束时交回
 * 这一步的回应，否则把最终文本交回，由调度器视为 continue。
 *
 * 被转交的运行（depth ≥ 1）在目标私聊的任务话题里进行：结果发在那里，同时交回转交者；
 * 任务的结局随这次运行落定。会话被打断（新的人类消息）时在步边界停止；被中止时立即停止。
 */
import type { Agent } from "@orgos/protocol";
import { eq } from "drizzle-orm";
import { contextLimits, recentWorkBrief, topicHistory } from "@/agent/context";
import {
	claimsEscalated,
	ESCALATION_CLAIM_CORRECTION,
} from "@/agent/escalation-claim";
import { framesFor } from "@/agent/frames";
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
import { buildSystemPrompt } from "@/agent/prompt";
import {
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
import { delegatableTeammates } from "@/agent/tools/delegate";
import {
	type DelegatedOutcome,
	deciderIn,
	type ToolScope,
} from "@/agent/tools/tool";
import type { ActingFor } from "@/agent/triggers";
import { conversations, principals } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { extractCitations, stripCitationMarks } from "@/memory/citations";
import { postAgentMessage, recordAgentAction } from "@/services/agent-events";
import { findAgent, listAgentsOf } from "@/services/agents";
import { memberPrincipals } from "@/services/conversations";
import {
	type NegotiationReply,
	negotiationContext,
} from "@/services/negotiations";
import {
	ABORTED_SUMMARY,
	finishRun,
	INTERRUPTED_SUMMARY,
	type RunEnd,
	startRun,
} from "@/services/runs";
import { openTaskOfTopic } from "@/services/tasks";
import { topicIn } from "@/services/topics";
import { unitContextOf } from "@/services/units";

export const STEP_LIMIT_TEXT = "这件事步骤太多，我先停在这里。";
/**
 * 替他人回答时放在最新消息之后的提醒：本人可能已更正过分身先前的回答，历史里的旧说法不可照搬。
 * 放在历史之后而非系统提示里（系统提示要保住提示缓存）。
 */
export const RECHECK_REMINDER =
	"【系统】回答这条消息前先调用 memory_search 查一次：你之前在对话里的回答可能已被本人更正，以这次检索结果为准（标着“本人更正”的优先）。";
export const MODEL_UNAVAILABLE_TEXT = "模型暂时不可用，请稍后再试。";

export type RunInput = {
	s: Scoped;
	agentId: string;
	conversationId: string;
	/** 运行所在的话题；缺省为主线。 */
	topicId?: string;
	actingFor: ActingFor;
	/** 触发文本与其中的 @；代理身份与会话类型由循环补齐。 */
	trigger: Omit<RunTrigger, "agent" | "conversationKind">;
	/** 运行记录里的触发来源：`event:<id>`、`work_item:<id>`、`run:<id>`、`negotiation:<id>`。 */
	triggerRef: string;
	/** 引起本次运行的人类消息。 */
	triggerEventId?: number;
	session: RunSession;
	llm: LlmClient;
	/** 转交：谁转交来的、当前深度、服务的任务。 */
	delegation?: { from: Agent; depth: number; taskId: string };
	/** negotiate 建好协商会话后，交给调度器驱动。 */
	startNegotiation: (negotiationConversationId: string) => void;
};

export type RunResult = {
	outcome: DelegatedOutcome;
	/** 最终文本（发出的消息、交回转交者的结果或协商中的一步）。 */
	text?: string;
	/** 协商中以 negotiation_reply 结束时的回应。 */
	reply?: NegotiationReply;
};

const SUMMARY_CHARS = 80;
const head = (text: string) => {
	const chars = Array.from(stripCitationMarks(text));
	return chars.length > SUMMARY_CHARS
		? `${chars.slice(0, SUMMARY_CHARS).join("")}…`
		: chars.join("");
};

/** 一次运行的结局写进运行记录；被转交的运行同时落定任务。 */
function runEndOf(
	res: RunResult,
	session: RunSession,
	delegated: boolean,
): RunEnd {
	const text = res.text ?? "";
	const base: RunEnd = (() => {
		switch (res.outcome) {
			case "posted":
			case "returned":
				return { state: "completed", summary: head(text) };
			case "passed":
				return { state: "completed", summary: "跳过" };
			case "ended":
				return {
					state: "completed",
					summary: res.reply ? head(res.reply.message) : "等本人处理",
				};
			case "stopped":
				return {
					state: "canceled",
					summary: session.signal.aborted
						? ABORTED_SUMMARY
						: INTERRUPTED_SUMMARY,
				};
			case "failed":
				return { state: "failed", summary: MODEL_UNAVAILABLE_TEXT };
			case "limit":
				return { state: "failed", summary: LIMIT_SUMMARY.modelCalls };
		}
	})();
	if (!delegated) return base;
	return {
		...base,
		taskState:
			base.state === "completed"
				? "completed"
				: base.state === "canceled"
					? "canceled"
					: "failed",
		taskSummary: stripCitationMarks(text) || (base.summary ?? ""),
	};
}

export async function runAgent(input: RunInput): Promise<RunResult> {
	const { s, session, actingFor, delegation } = input;
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
	const topic = await topicIn(s, conversation.id, input.topicId);
	const taskId =
		delegation?.taskId ?? (await openTaskOfTopic(s, topic))?.id ?? null;
	const run = await startRun(s, {
		agentId: agent.principal.id,
		conversationId: conversation.id,
		topicId: topic.id,
		taskId,
		trigger: input.triggerRef,
		actingForId: actingFor.kind === "other" ? actingFor.principalId : owner.id,
		engine: "builtin",
	});
	let result: RunResult = { outcome: "failed" };
	try {
		result = await runLoop(input, {
			agent,
			owner,
			conversation,
			topic,
			runId: run.id,
			taskId,
		});
		return result;
	} finally {
		await finishRun(s, run.id, runEndOf(result, session, !!delegation));
	}
}

type Resolved = {
	agent: Agent;
	owner: PrincipalRow;
	conversation: typeof conversations.$inferSelect;
	topic: Awaited<ReturnType<typeof topicIn>>;
	runId: string;
	taskId: string | null;
};

async function runLoop(input: RunInput, r: Resolved): Promise<RunResult> {
	const { s, session, llm, actingFor, delegation } = input;
	const { agent, owner, conversation, topic, runId } = r;
	const depth = delegation?.depth ?? 0;
	const negotiation = conversation.kind === "negotiation";
	const posts = !negotiation;
	const agentId = agent.principal.id;
	const place = { conversationId: conversation.id, topicId: topic.id };
	const members = await memberPrincipals(s, conversation.id);
	const nameOf = (id: string) => members.get(id)?.displayName ?? "同事";
	const frames = framesFor([...members.keys()], {
		conversationId: conversation.id,
		topicId: topic.id,
		agentId,
		runId,
	});
	const act = (tool: string, summary: string, ok: boolean) =>
		recordAgentAction(s, agentId, place, { tool, summary, ok });

	const scope: ToolScope = {
		s,
		agent,
		owner,
		unit: await unitContextOf(
			s,
			owner,
			actingFor.kind === "other" ? actingFor.principalId : null,
		),
		conversation: {
			id: conversation.id,
			kind: conversation.kind,
			topicId: topic.id,
		},
		runId,
		actingFor,
		depth,
		triggerEventId: depth === 0 ? (input.triggerEventId ?? null) : null,
		session,
		teammates: delegatableTeammates(
			await listAgentsOf(s, owner.id),
			agent,
			actingFor,
		),
		delegate(target, task, where) {
			return runAgent({
				...input,
				agentId: target.principal.id,
				conversationId: where.conversationId,
				topicId: where.topicId,
				trigger: { text: task, mentions: [] },
				triggerRef: `run:${runId}`,
				triggerEventId: undefined,
				delegation: { from: agent, depth: depth + 1, taskId: where.taskId },
			});
		},
		startNegotiation: input.startNegotiation,
	};
	/** 替本人回答他人时，回复记下提问人与所答的消息（代答记录据此列出）。 */
	const answerExtra =
		actingFor.kind === "other"
			? {
					askedById: actingFor.principalId,
					...(scope.triggerEventId !== null
						? { replyToEventId: scope.triggerEventId }
						: {}),
				}
			: {};
	const tools = availableTools(scope);
	const ctx = negotiation
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
				topicTitle: topic.isMain ? null : topic.title,
				delegatedBy: delegation?.from ?? null,
				resume: input.trigger.resume ?? null,
			});
	const meta = {
		tenantId: s.tenantId,
		agentId,
		onBehalfOfId: actingFor.kind === "other" ? actingFor.principalId : owner.id,
		conversationId: conversation.id,
		runId,
		taskId: r.taskId,
		model: agent.model,
	};
	const history: ChatMessage[] = delegation
		? [
				{
					role: "user",
					content: `【${delegation.from.principal.displayName}转交】${input.trigger.text}`,
				},
			]
		: ctx
			? negotiationMessages(ctx, agentId, nameOf, owner.displayName)
			: await topicHistory({
					s,
					topic,
					agent: { id: agentId, handle: agent.principal.handle },
					conversationKind: conversation.kind,
					nameOf,
					system,
					llm,
					meta,
					signal: session.signal,
					limits: contextLimits(agent.model),
				});
	const brief = ctx
		? null
		: await recentWorkBrief(s, {
				agentId,
				currentTopicId: topic.id,
				visibleTo: actingFor.kind === "other" ? actingFor.principalId : null,
			});
	const recheck =
		!ctx &&
		actingFor.kind === "other" &&
		!input.trigger.resume &&
		tools.some((t) => t.name === "memory_search");
	/** 上报的运行时校验：只在能上报的运行里（为他人、直接被问到），上报答复后的恢复运行除外。 */
	const checksClaims =
		tools.some((t) => t.name === "escalate_to_owner") && !input.trigger.resume;
	const deciderName = deciderIn(scope).displayName;
	let claimCorrected = false;
	const messages: ChatMessage[] = [
		{ role: "system", content: system },
		...history,
		...(brief ? [{ role: "user" as const, content: brief }] : []),
		...(recheck ? [{ role: "user" as const, content: RECHECK_REMINDER }] : []),
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
					await postAgentMessage(s, agentId, place, MODEL_UNAVAILABLE_TEXT);
				return { outcome: "failed", text: MODEL_UNAVAILABLE_TEXT };
			}
			if (session.stopped) return { outcome: "stopped" };

			if (res.toolCalls.length === 0) {
				const text = res.text.trim() || "（没有可说的）";
				if (!posts) return { outcome: "returned", text };
				const unescalated = checksClaims && claimsEscalated(text, deciderName);
				if (unescalated && !claimCorrected) {
					claimCorrected = true;
					messages.push(
						{ role: "assistant", content: text },
						{ role: "user", content: ESCALATION_CLAIM_CORRECTION },
					);
					continue;
				}
				const said = extractCitations(text, session.citable);
				await postAgentMessage(s, agentId, place, said.text || text, {
					extra: { citations: said.citations, ...answerExtra },
				});
				if (unescalated)
					await act(
						"system",
						`回复声称已转交${deciderName}本人，但本轮没有调用 escalate_to_owner，未上报`,
						false,
					);
				return { outcome: "posted", text };
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
				if (out.replied) {
					const { html, summary } = out.replied;
					await postAgentMessage(s, agentId, place, html, {
						format: "html",
						extra: { summary, ...answerExtra },
					});
					return { outcome: "posted", text: summary };
				}
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
		if (posts) await postAgentMessage(s, agentId, place, STEP_LIMIT_TEXT);
		await act("system", LIMIT_SUMMARY.modelCalls, false);
		return { outcome: "limit", text: STEP_LIMIT_TEXT };
	} finally {
		frames.status("idle");
	}
}
