/**
 * delegate_to_teammate：同步运行同组的一位代理一次，把它的最终文本作为工具结果。
 * 为他人办事时只能交给同组的助手，且助手同样处于"为他人"限制；深度 ≤ 2。
 */
import { HandleSchema } from "@orgos/protocol";
import { z } from "zod";
import { MAX_DELEGATE_DEPTH } from "@/agent/session";
import { forOwner, makeTool } from "@/agent/tools/tool";
import { findAgent } from "@/services/agents";

export const delegateTool = makeTool({
	name: "delegate_to_teammate",
	description:
		"把一件具体的活交给同组的另一位代理（按 handle 指定），等它做完后拿到结果。task 要写清楚要做什么、要交回什么。",
	label: "正在交给同事…",
	schema: z.object({
		handle: HandleSchema,
		task: z.string().trim().min(1).max(4000),
	}),
	available: (scope) => scope.depth < MAX_DELEGATE_DEPTH,
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
		if (!forOwner(scope) && teammate.role !== "specialist") {
			return {
				result: "无权限：替他人办事时只能交给同组的助手",
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
		const text = await scope.delegate(teammate, task);
		return {
			result: text,
			summary: `交给${teammate.principal.displayName}：${task}`,
			ok: true,
		};
	},
});
