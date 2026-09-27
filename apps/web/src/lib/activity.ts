/**
 * 代理"正在工作"的前端状态：按会话、按代理记当前运行的状态与流式草稿。
 * 由 WS 的 status / draft 帧驱动；代理的消息落库或运行结束（idle）时清除。纯函数，便于测试。
 */
import type { AgentRunState, BrowserFrame } from "@orgos/protocol";

export type AgentActivity = {
	runId: string;
	state: Exclude<AgentRunState, "idle">;
	/** 执行工具时的说明（"正在查资料…"）。 */
	label?: string;
	/** 这一步模型输出的流式文本。 */
	draft: string;
};

/** conversationId → agentId → 活动。 */
export type ActivityMap = Readonly<
	Record<string, Readonly<Record<string, AgentActivity>>>
>;

type DraftFrame = Extract<BrowserFrame, { t: "draft" }>;
type StatusFrame = Extract<BrowserFrame, { t: "status" }>;

function put(
	map: ActivityMap,
	conversationId: string,
	agentId: string,
	next: AgentActivity | null,
): ActivityMap {
	const { [agentId]: _, ...rest } = map[conversationId] ?? {};
	const agents = next ? { ...rest, [agentId]: next } : rest;
	const { [conversationId]: __, ...others } = map;
	return Object.keys(agents).length > 0
		? { ...others, [conversationId]: agents }
		: others;
}

/**
 * thinking：新的一步开始，草稿清空；tool：换成灰字说明；idle：本次运行结束，移除。
 */
export function applyStatusFrame(
	map: ActivityMap,
	f: StatusFrame,
): ActivityMap {
	if (f.state === "idle") {
		const cur = map[f.conversationId]?.[f.agentId];
		return cur && cur.runId !== f.runId
			? map
			: put(map, f.conversationId, f.agentId, null);
	}
	return put(map, f.conversationId, f.agentId, {
		runId: f.runId,
		state: f.state,
		...(f.label ? { label: f.label } : {}),
		draft: "",
	});
}

export function applyDraftFrame(map: ActivityMap, f: DraftFrame): ActivityMap {
	const cur = map[f.conversationId]?.[f.agentId];
	const base =
		cur && cur.runId === f.runId
			? cur
			: { runId: f.runId, state: "thinking" as const, draft: "" };
	return put(map, f.conversationId, f.agentId, {
		...base,
		state: "thinking",
		draft: base.draft + f.delta,
	});
}

/** 代理的消息已落库：它的草稿与工作指示不再需要。 */
export function clearAgentActivity(
	map: ActivityMap,
	conversationId: string,
	agentId: string,
): ActivityMap {
	return map[conversationId]?.[agentId]
		? put(map, conversationId, agentId, null)
		: map;
}
