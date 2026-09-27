/**
 * 协商（C4）的两个工具。
 *
 * - negotiate：分身为本人办事时，去和另一位同事的分身协商一件事。经 `startNegotiation` 建协商会话
 *   （两人私聊里落协商卡片），随后由调度器驱动两个分身轮流回应；本次运行照常继续。
 * - negotiation_reply：只在协商会话里可用，每一步必须以它结束；回应交给调度器按
 *   `@/services/negotiations` 的规则判定。agree 不成立时退回给模型改正，不算一步。
 */
import { NEGOTIATION_STATUSES } from "@orgos/protocol";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { forOwner, makeTool } from "@/agent/tools/tool";
import { principals } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { requireTwinOf } from "@/services/agents";
import {
	agreeProblem,
	negotiationStateOf,
	startNegotiation,
} from "@/services/negotiations";

export const NOT_FOUND_TEXT = "找不到此人";
const TITLE_CHARS = 40;

/** 本租户里的人：按 handle（可带 @），否则按唯一的显示名。 */
async function findPerson(
	s: Scoped,
	who: string,
): Promise<PrincipalRow | null> {
	const key = who.trim().replace(/^@/, "");
	const byHandle = await s.first(
		principals,
		eq(principals.kind, "human"),
		eq(principals.handle, key),
	);
	if (byHandle) return byHandle;
	const byName = await s.select(
		principals,
		eq(principals.kind, "human"),
		eq(principals.displayName, key),
	);
	return byName.length === 1 ? (byName[0] ?? null) : null;
}

export const negotiateTool = makeTool({
	name: "negotiate",
	description:
		"替本人去和另一位同事的分身协商一件事（例如约会议时间）。personHandle 是对方的 handle 或姓名；goal 用一两句话写清要谈成什么，带上本人说过的全部约束（时长、可选日期与时段、议题等），不要添加本人没说过的要求。协商在后台自动进行，结果会发回这里并请双方本人确认；调用后简短告诉本人已经开始即可，不要等待。",
	label: "正在发起协商…",
	schema: z.object({
		personHandle: z.string().trim().min(1).max(60),
		goal: z.string().trim().min(1).max(2000),
	}),
	available: (scope) =>
		scope.agent.role === "front" &&
		forOwner(scope) &&
		scope.depth === 0 &&
		scope.conversation.kind !== "negotiation",
	run: async ({ personHandle, goal }, scope) => {
		const person = await findPerson(scope.s, personHandle);
		if (!person || person.id === scope.owner.id) {
			return {
				result: NOT_FOUND_TEXT,
				summary: `发起协商失败：找不到“${personHandle}”`,
				ok: false,
			};
		}
		const twin = await requireTwinOf(scope.s, person.id);
		const chars = Array.from(goal);
		const negotiation = await startNegotiation(scope.s, {
			initiatorAgentId: scope.agent.principal.id,
			responderAgentId: twin.id,
			goal,
			title: `${chars.slice(0, TITLE_CHARS).join("")}${chars.length > TITLE_CHARS ? "…" : ""}`,
			originConversationId: scope.conversation.id,
			originTopicId: scope.conversation.topicId,
		});
		scope.startNegotiation(negotiation.id);
		return {
			result: `已发起与${person.displayName}的分身的协商，结果会自动发到这里。`,
			summary: `已发起与${person.displayName}的代理协商：${goal}`,
			ok: true,
		};
	},
});

const STATUS_LABEL: Record<(typeof NEGOTIATION_STATUSES)[number], string> = {
	continue: "提议或回应",
	agree: "同意",
	reject: "拒绝",
	need_owner: "请本人定",
};

export const negotiationReplyTool = makeTool({
	name: "negotiation_reply",
	description:
		"协商中你每一轮的唯一出口：调用一次就结束这一轮。status：continue（提出或修改方案，必须带完整 proposal；或回应但还没同意）/ agree（接受对方最近的 proposal，必须原样带上它）/ reject（谈不成，终止协商）/ need_owner（需要本人拍板，message 写给本人、问清要本人定什么）。其余状态的 message 用一两句话写给对方的分身。proposal 是 JSON 对象，用简短的键值写出完整方案。",
	label: "正在回应对方…",
	schema: z.object({
		status: z.enum(NEGOTIATION_STATUSES),
		message: z.string().trim().min(1).max(2000),
		proposal: z.record(z.string(), z.unknown()).optional(),
	}),
	available: (scope) =>
		scope.conversation.kind === "negotiation" && scope.depth === 0,
	run: async ({ status, message, proposal }, scope) => {
		if (status === "agree") {
			const state = await negotiationStateOf(scope.s, scope.conversation.id);
			const problem = agreeProblem(state, scope.agent.principal.id, proposal);
			if (problem) {
				return {
					result: `没有提交：${problem}`,
					summary: "同意未提交：与对方最近的提案不符",
					ok: false,
				};
			}
		}
		return {
			result: "已提交",
			summary: `回应对方：${STATUS_LABEL[status]}`,
			ok: true,
			end: true,
			reply: {
				status,
				message,
				...(proposal === undefined ? {} : { proposal }),
			},
		};
	},
});
