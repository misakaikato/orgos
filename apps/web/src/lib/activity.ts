/**
 * 代理"正在工作"的前端状态：按会话、按（话题, 代理）记当前运行的状态与流式草稿。
 * 由 WS 的 status / draft 帧驱动；代理的消息落库或运行结束（idle）时清除。纯函数，便于测试。
 * 同一代理可以同时在同一会话的两个话题里工作（例如外部助手的两个会话）。
 */
import type { AgentRunState, BrowserFrame } from "@orgos/protocol";

export type AgentActivity = {
	agentId: string;
	/** 运行所在的话题（旧服务端不带时为空，视为主线）。 */
	topicId?: string;
	runId: string;
	state: Exclude<AgentRunState, "idle">;
	/** 执行工具时的说明（"正在查资料…"）。 */
	label?: string;
	/** 这一步模型输出的流式文本。 */
	draft: string;
};

/** conversationId → `${topicId}:${agentId}` → 活动。 */
export type ActivityMap = Readonly<
	Record<string, Readonly<Record<string, AgentActivity>>>
>;

type DraftFrame = Extract<BrowserFrame, { t: "draft" }>;
type StatusFrame = Extract<BrowserFrame, { t: "status" }>;

function slot(topicId: string | undefined, agentId: string): string {
	return `${topicId ?? ""}:${agentId}`;
}

function put(
	map: ActivityMap,
	conversationId: string,
	key: string,
	next: AgentActivity | null,
): ActivityMap {
	const { [key]: _, ...rest } = map[conversationId] ?? {};
	const agents = next ? { ...rest, [key]: next } : rest;
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
	const key = slot(f.topicId, f.agentId);
	if (f.state === "idle") {
		const cur = map[f.conversationId]?.[key];
		return cur && cur.runId !== f.runId
			? map
			: put(map, f.conversationId, key, null);
	}
	return put(map, f.conversationId, key, {
		agentId: f.agentId,
		...(f.topicId ? { topicId: f.topicId } : {}),
		runId: f.runId,
		state: f.state,
		...(f.label ? { label: f.label } : {}),
		draft: "",
	});
}

export function applyDraftFrame(map: ActivityMap, f: DraftFrame): ActivityMap {
	const key = slot(f.topicId, f.agentId);
	const cur = map[f.conversationId]?.[key];
	const base: AgentActivity =
		cur && cur.runId === f.runId
			? cur
			: {
					agentId: f.agentId,
					...(f.topicId ? { topicId: f.topicId } : {}),
					runId: f.runId,
					state: "thinking",
					draft: "",
				};
	return put(map, f.conversationId, key, {
		...base,
		state: "thinking",
		draft: base.draft + f.delta,
	});
}

/** 代理在某话题的消息已落库：它在那里的草稿与工作指示不再需要。 */
export function clearAgentActivity(
	map: ActivityMap,
	conversationId: string,
	agentId: string,
	topicId?: string,
): ActivityMap {
	const key = slot(topicId, agentId);
	return map[conversationId]?.[key] ? put(map, conversationId, key, null) : map;
}

/** 某话题里正在工作的代理（主线也收旧服务端不带话题的活动）。 */
export function activityIn(
	agents: Readonly<Record<string, AgentActivity>> | undefined,
	topicId: string,
	isMain: boolean,
): AgentActivity[] {
	return Object.values(agents ?? {}).filter((a) =>
		a.topicId ? a.topicId === topicId : isMain,
	);
}

/** 会话里某代理是否在任何话题里工作（会话列表的团子动画）。 */
export function isWorkingIn(
	agents: Readonly<Record<string, AgentActivity>> | undefined,
	agentId: string,
): boolean {
	return Object.values(agents ?? {}).some((a) => a.agentId === agentId);
}
