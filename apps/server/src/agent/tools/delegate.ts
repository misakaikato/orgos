/**
 * delegate_to_teammate：把一件活交给同组的一位代理——每次交办都是一个任务，也就是目标私聊
 * （本人与该代理的私聊）里新开的一个任务话题。
 *
 * - 内置代理：建 engine=builtin 的任务话题，同步运行它一次（结果发在任务话题里），任务随之结束，
 *   结果作为工具结果交回；
 * - 外部助手（只为本人）：建任务话题并在其 ACP 会话里交办，等这一轮结束，交回它的进度摘要。
 *
 * 可交办范围只由 `delegatableTeammates` 决定：为他人办事时只能交给同组的内置助手，
 * 且助手同样处于"为他人"限制；外部助手只替本人干活。深度 ≤ 2。
 */
import {
	type Agent,
	HandleSchema,
	isExternalAgent,
	type TaskState,
} from "@orgos/protocol";
import { z } from "zod";
import { MAX_DELEGATE_DEPTH } from "@/agent/session";
import { makeTool, type ToolScope } from "@/agent/tools/tool";
import type { ActingFor } from "@/agent/triggers";
import { findAgent } from "@/services/agents";
import { openDm } from "@/services/conversations";
import { externalSessions } from "@/services/external-sessions";
import { createTask } from "@/services/tasks";

/** 本次运行可以交办的同事（同组、不含自己）。 */
export function delegatableTeammates(
	team: readonly Agent[],
	self: Pick<Agent, "principal">,
	actingFor: ActingFor,
): Agent[] {
	return team.filter(
		(a) =>
			a.principal.id !== self.principal.id &&
			a.principal.ownerId === self.principal.ownerId &&
			(actingFor.kind === "owner" ||
				(a.role === "specialist" && !isExternalAgent(a))),
	);
}

const STATE_TEXT: Partial<Record<TaskState, string>> = {
	failed: "任务失败",
	canceled: "任务已取消",
	awaiting_approval: "还在等本人批准",
	working: "还在进行中",
};

async function delegateToExternal(
	scope: ToolScope,
	teammate: Agent,
	task: string,
) {
	const name = teammate.principal.displayName;
	const done = await externalSessions.delegate(scope.s, teammate, {
		requesterId: scope.agent.principal.id,
		goal: task,
		parentRunId: scope.runId,
		signal: scope.session.stopSignal,
	});
	const { state, resultSummary } = done;
	const note = STATE_TEXT[state];
	return {
		result: [note, resultSummary].filter(Boolean).join("：") || "没有结果",
		summary: `交给${name}：${task}`,
		ok: state !== "failed" && state !== "canceled",
	};
}

export const delegateTool = makeTool({
	name: "delegate_to_teammate",
	description:
		"把一件具体的活交给同组的另一位代理（按 handle 指定），等它做完后拿到结果。task 要写清楚要做什么、要交回什么。",
	label: "正在交给同事…",
	schema: z.object({
		handle: HandleSchema,
		task: z.string().trim().min(1).max(4000),
	}),
	// 单元没有助手：单元分身不交办。
	available: (scope) => scope.unit === null && scope.depth < MAX_DELEGATE_DEPTH,
	run: async ({ handle, task }, scope) => {
		const target = await findAgent(scope.s, { handle });
		const teammate =
			target &&
			target.principal.ownerId === scope.owner.id &&
			target.principal.id !== scope.agent.principal.id
				? target
				: null;
		if (!teammate) {
			return {
				result: `找不到同组的代理 @${handle}`,
				summary: `转交失败：找不到同组的代理 @${handle}`,
				ok: false,
			};
		}
		if (
			delegatableTeammates([teammate], scope.agent, scope.actingFor).length ===
			0
		) {
			return {
				result: "无权限：替他人办事时只能交给同组的内置助手",
				summary: `转交给${teammate.principal.displayName}：无权限`,
				ok: false,
			};
		}
		if (!scope.session.takeHandoff()) {
			return {
				result: "代理之间的交接次数已达上限，停止转交",
				summary: "转交失败：交接次数已达上限",
				ok: false,
			};
		}
		if (isExternalAgent(teammate))
			return delegateToExternal(scope, teammate, task);

		const { conversation } = await openDm(
			scope.s,
			scope.owner,
			teammate.principal.id,
		);
		const { task: created, topic } = await createTask(scope.s, {
			conversationId: conversation.id,
			requesterId: scope.agent.principal.id,
			assignee: { id: teammate.principal.id, ownerId: scope.owner.id },
			onBehalfOfId:
				scope.actingFor.kind === "other"
					? scope.actingFor.principalId
					: scope.owner.id,
			goal: task,
			engine: "builtin",
		});
		const run = await scope.delegate(teammate, task, {
			conversationId: conversation.id,
			topicId: topic.id,
			taskId: created.id,
		});
		const text = run.text ?? "没有结果";
		return {
			result: text,
			summary: `交给${teammate.principal.displayName}：${task}`,
			ok: run.outcome !== "failed" && run.outcome !== "stopped",
		};
	},
});
