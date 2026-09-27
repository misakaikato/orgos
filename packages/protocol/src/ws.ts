/**
 * 浏览器 WS 帧（仅服务端 → 浏览器）。发送一律走 REST。
 */
import { z } from "zod";
import { PRINCIPAL_STATUSES, TaskSchema, WorkItemSchema } from "./entities";
import { EventSchema } from "./events";
import { RunnerSchema } from "./runner";

export const BROWSER_PING_INTERVAL_MS = 20_000;

export const AGENT_RUN_STATES = ["thinking", "tool", "idle"] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

/** 浏览器 WS 的关闭码。 */
export const WS_CLOSE = {
	UNAUTHORIZED: 4401,
	NOT_ONBOARDED: 4404,
} as const;

export const BrowserFrameSchema = z.discriminatedUnion("t", [
	z.object({ t: z.literal("event"), event: EventSchema }),
	z.object({ t: z.literal("ping") }),
	/** 同租户某人的在线状态变了。 */
	z.object({
		t: z.literal("presence"),
		principalId: z.uuid(),
		status: z.enum(PRINCIPAL_STATUSES),
	}),
	/** 代理回复的流式增量；同一 runId 的增量按到达顺序拼接。 */
	z.object({
		t: z.literal("draft"),
		conversationId: z.uuid(),
		agentId: z.uuid(),
		runId: z.string(),
		delta: z.string(),
	}),
	/** 代理的运行状态：thinking 时新一步开始（草稿清空），tool 时 label 说明在做什么，idle 表示本次运行结束。 */
	z.object({
		t: z.literal("status"),
		conversationId: z.uuid(),
		agentId: z.uuid(),
		runId: z.string(),
		state: z.enum(AGENT_RUN_STATES),
		label: z.string().optional(),
	}),
	/** 我的待办新增或变化。 */
	z.object({ t: z.literal("work_item"), workItem: WorkItemSchema }),
	/** 我的设备新增、上下线或被吊销。 */
	z.object({ t: z.literal("runner"), runner: RunnerSchema }),
	/** 任务有变化（进度、产出、状态）：推给交办所在会话的成员，不落库。 */
	z.object({ t: z.literal("task"), task: TaskSchema }),
]);
export type BrowserFrame = z.infer<typeof BrowserFrameSchema>;

export type ParseResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: string };

/** 解析一帧文本；不抛异常。 */
export function parseBrowserFrame(raw: string): ParseResult<BrowserFrame> {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: "不是合法 JSON" };
	}
	const parsed = BrowserFrameSchema.safeParse(json);
	return parsed.success
		? { ok: true, data: parsed.data }
		: { ok: false, error: parsed.error.message };
}
