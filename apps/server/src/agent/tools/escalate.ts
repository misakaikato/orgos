/**
 * escalate_to_owner：替他人办事时遇到超出授权的问题，转给本人答复。
 * 经 `escalateToOwner` 建 decision 待办并在会话里落上报卡片；本次运行随即结束，
 * 本人答复后调度器恢复同一代理，在同一会话里回复提问者。
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { deciderIn, forOwner, makeTool } from "@/agent/tools/tool";
import { principals } from "@/db/schema";
import { escalateToOwner } from "@/services/work-items";

const HEAD_CHARS = 40;

function headOf(question: string): string {
	const chars = Array.from(question);
	return `${chars.slice(0, HEAD_CHARS).join("")}${chars.length > HEAD_CHARS ? "…" : ""}`;
}

/** 待办标题：`许诺问：<问题前 40 字>`；问题本身已以提问人开头时不再重复。 */
function titleOf(requesterName: string, question: string): string {
	const head = headOf(question);
	return question.startsWith(requesterName)
		? head
		: `${requesterName}问：${head}`;
}

export const escalateTool = makeTool({
	name: "escalate_to_owner",
	description:
		"把超出你授权的问题转给本人答复（新的承诺、决定，或对外政策要求问本人的事）。question 写清楚对方要什么、相关背景。问题有明确的几种答法时（同意 / 不同意 / 折中，或几个具体的日期、价格），用 options 给出 2–4 个候选答复，本人点一下就能答复：每条是可以直接转告对方的完整答复（例如“可以，85 折按一年合同签”），不超过 60 字，互不重复；答法开放的问题不给。调用后本次回复结束，对方会看到“已转给本人”，本人答复后你会被叫回来转告对方。",
	label: "正在转给本人…",
	schema: z.object({
		question: z.string().trim().min(1).max(2000),
		options: z.array(z.string()).optional(),
	}),
	available: (scope) =>
		!forOwner(scope) &&
		scope.depth === 0 &&
		scope.conversation.kind !== "negotiation",
	run: async ({ question, options }, scope) => {
		if (scope.actingFor.kind !== "other")
			throw new Error("escalate_to_owner 只在为他人办事时可用");
		const requester = await scope.s.first(
			principals,
			eq(principals.id, scope.actingFor.principalId),
		);
		const requesterName = requester?.displayName ?? "同事";
		await escalateToOwner(scope.s, {
			agentId: scope.agent.principal.id,
			conversationId: scope.conversation.id,
			topicId: scope.conversation.topicId,
			requesterId: scope.actingFor.principalId,
			question,
			...(options ? { options } : {}),
			title: titleOf(requesterName, question),
			sourceEventId: scope.triggerEventId,
		});
		const decider = deciderIn(scope);
		return {
			result: `已转给${decider.displayName}本人`,
			summary: `转给${decider.displayName}本人：${headOf(question)}`,
			ok: true,
			end: true,
		};
	},
});
