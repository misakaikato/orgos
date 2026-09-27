/**
 * 代理工具的定义方式：一个 Zod schema 同时产出给模型的 JSON schema（z.toJSONSchema）
 * 与执行前的入参校验（safeParse），二者不会漂移。
 *
 * 可用性按运行上下文（行事对象、会话类型、转交深度）判定：不可用的工具不出现在工具列表里，
 * 模型编造调用也只会得到"无权限"。
 */
import type { Agent, CONVERSATION_KINDS } from "@orgos/protocol";
import { z } from "zod";
import type { RunSession } from "@/agent/session";
import type { ActingFor } from "@/agent/triggers";
import type { PrincipalRow, Scoped } from "@/db/scope";
import type { NegotiationReply } from "@/services/negotiations";

export type ToolScope = {
	s: Scoped;
	agent: Agent;
	owner: PrincipalRow;
	conversation: { id: string; kind: (typeof CONVERSATION_KINDS)[number] };
	actingFor: ActingFor;
	/** 转交深度：直接被触发的运行为 0。 */
	depth: number;
	/** 引起本次运行的人类消息（上报待办的来源事件）；恢复运行与转交时为 null。 */
	triggerEventId: number | null;
	session: RunSession;
	/** 本次可以交办的同事（见 delegate 工具的 `delegatableTeammates`）。 */
	teammates: readonly Agent[];
	/** 同步运行一位同组的内置代理一次，返回它的结局与最终文本。 */
	delegate(
		target: Agent,
		task: string,
	): Promise<{ outcome: DelegatedOutcome; text?: string }>;
	/** 协商会话已建好：交给调度器驱动两个分身轮流回应（不等待）。 */
	startNegotiation(negotiationConversationId: string): void;
};

/** 被交办的运行怎么结束的（同 loop 的 RunResult.outcome）。 */
export type DelegatedOutcome =
	| "posted"
	| "returned"
	| "passed"
	| "ended"
	| "stopped"
	| "failed"
	| "limit";

export type ToolOutcome = {
	/** 作为工具结果交还给模型的文本。 */
	result: string;
	/** 落在 agent.action 里、给人看的一句话。 */
	summary: string;
	ok: boolean;
	/** pass：本次运行无声结束。 */
	pass?: true;
	/** 记下动作后本次运行随即结束，不再产生回复消息（上报后等本人答复、协商中回应了一步）。 */
	end?: true;
	/** 协商中的这一步回应（negotiation_reply）。 */
	reply?: NegotiationReply;
};

export type AgentTool = {
	name: string;
	description: string;
	/** 执行时状态行的灰字。 */
	label: string;
	parameters: unknown;
	available(scope: ToolScope): boolean;
	execute(raw: unknown, scope: ToolScope): Promise<ToolOutcome>;
};

export function makeTool<S extends z.ZodType>(def: {
	name: string;
	description: string;
	label: string;
	schema: S;
	available: (scope: ToolScope) => boolean;
	run: (args: z.infer<S>, scope: ToolScope) => Promise<ToolOutcome>;
}): AgentTool {
	return {
		name: def.name,
		description: def.description,
		label: def.label,
		parameters: z.toJSONSchema(def.schema),
		available: def.available,
		async execute(raw, scope) {
			const parsed = def.schema.safeParse(raw ?? {});
			if (!parsed.success) {
				const first = parsed.error.issues[0];
				const at = first?.path.length ? `（${first.path.join(".")}）` : "";
				return {
					result: `参数不合法${at}：${first?.message ?? "校验失败"}`,
					summary: `调用 ${def.name} 的参数不合法`,
					ok: false,
				};
			}
			return def.run(parsed.data, scope);
		},
	};
}

export const forOwner = (scope: ToolScope) => scope.actingFor.kind === "owner";
