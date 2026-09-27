/**
 * 代理一次运行看到的历史：只来自当前话题（新群的主线另带它引用的原话题作为前置历史），
 * 外加压缩检查点与近期工作简报。
 *
 * 压缩：运行前估算上下文超过 `模型窗口 - 预留` 或未压缩事件超过上限时，先由同一模型把较早的部分
 * 写成结构化检查点（目标、进展、决定、下一步、涉及文件）存进 compactions，之后该话题的运行
 * 从检查点 + 其后事件开始；最近约 keepRecentTokens 的内容保留原文。
 *
 * 近期工作简报：该代理过去 48 小时在其他话题与会话里说的最后一句，最多 10 行、约 350 token，
 * 放在历史之后（不进系统提示，以保住提示缓存）；为他人办事时只列对方也在的会话。
 */
import { contextWindowOf, type Event } from "@orgos/protocol";
import { and, asc, desc, eq, gt, inArray, ne } from "drizzle-orm";
import type {
	ChatMessage,
	LlmClient,
	LlmMeta,
	RunTrigger,
} from "@/agent/llm-types";
import { historyMessages } from "@/agent/prompt";
import {
	compactions,
	conversationMembers,
	conversations,
	events,
	principals,
	topics,
} from "@/db/schema";
import type { Scoped } from "@/db/scope";
import { toEvent } from "@/lib/serialize";
import type { TopicRow } from "@/services/topics";

export type ContextLimits = {
	/** 模型的上下文窗口（token）。 */
	windowTokens: number;
	/** 为系统提示之外的输出与工具结果预留的余量。 */
	reserveTokens: number;
	/** 未压缩事件超过这个数也压缩。 */
	maxEvents: number;
	/** 压缩时保留原文的最近内容（token）。 */
	keepRecentTokens: number;
};

export const DEFAULT_RESERVE_TOKENS = 16_000;
export const DEFAULT_MAX_EVENTS = 400;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

function envInt(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 压缩阈值：按模型窗口取默认值，可用环境变量覆盖（测试用小阈值）。 */
export function contextLimits(model: string): ContextLimits {
	return {
		windowTokens:
			envInt("ORGOS_CONTEXT_WINDOW_TOKENS") ?? contextWindowOf(model),
		reserveTokens:
			envInt("ORGOS_CONTEXT_RESERVE_TOKENS") ?? DEFAULT_RESERVE_TOKENS,
		maxEvents: envInt("ORGOS_COMPACT_MAX_EVENTS") ?? DEFAULT_MAX_EVENTS,
		keepRecentTokens:
			envInt("ORGOS_COMPACT_KEEP_TOKENS") ?? DEFAULT_KEEP_RECENT_TOKENS,
	};
}

/** 粗估 token：按字符计（中文约一字一 token，英文偏高估，宁可早压缩）。 */
export function estimateTokens(text: string | null | undefined): number {
	return text ? Array.from(text).length : 0;
}

function messageTokens(messages: readonly ChatMessage[]): number {
	let n = 0;
	for (const m of messages) n += estimateTokens(m.content);
	return n;
}

export const CHECKPOINT_PROMPT = [
	"你在为一段工作对话写压缩检查点，供之后接着工作时代替原文。",
	"按以下五项写，每项一两行，只写对话里有的内容，不要编造：",
	"目标：",
	"进展：",
	"决定：",
	"下一步：",
	"涉及文件：",
	"没有的项写“（无）”。用中文，不要其他内容。",
].join("\n");

export const CHECKPOINT_PREFIX = "【检查点】这个话题更早的内容已压缩为：";

/** 当前话题（与它引用的原话题）的全部事件，按写入顺序。 */
async function topicEvents(s: Scoped, topic: TopicRow): Promise<Event[]> {
	const ids = [topic.id, ...(topic.sourceTopicId ? [topic.sourceTopicId] : [])];
	const rows = await s.executor
		.select()
		.from(events)
		.where(s.where(events, inArray(events.topicId, ids)))
		.orderBy(asc(events.id));
	return rows.map(toEvent);
}

async function latestCheckpoint(s: Scoped, topicId: string, agentId: string) {
	const [row] = await s.executor
		.select()
		.from(compactions)
		.where(
			s.where(
				compactions,
				eq(compactions.topicId, topicId),
				eq(compactions.agentId, agentId),
			),
		)
		.orderBy(desc(compactions.createdAt), desc(compactions.afterEventId))
		.limit(1);
	return row;
}

export type HistoryInput = {
	s: Scoped;
	topic: TopicRow;
	agent: { id: string; handle: string };
	conversationKind: RunTrigger["conversationKind"];
	nameOf: (principalId: string) => string;
	/** 系统提示（计入上下文估算）。 */
	system: string;
	llm: LlmClient;
	meta: LlmMeta;
	signal: AbortSignal;
	limits: ContextLimits;
};

/**
 * 较早的事件压缩成检查点时，从末尾保留原文的起点：保留最近约 keepRecentTokens 的内容，
 * 且至多 maxEvents 的一半条事件；至少留一条。返回保留部分的起始下标。
 */
function keepFrom(
	pending: readonly Event[],
	agentId: string,
	nameOf: (id: string) => string,
	limits: ContextLimits,
): number {
	const maxKept = Math.max(1, Math.floor(limits.maxEvents / 2));
	let tokens = 0;
	let i = pending.length;
	while (i > 0 && pending.length - i < maxKept) {
		const e = pending[i - 1];
		if (!e) break;
		const cost = messageTokens(historyMessages([e], agentId, nameOf));
		if (i < pending.length && tokens + cost > limits.keepRecentTokens) break;
		tokens += cost;
		i -= 1;
	}
	return i;
}

function transcript(messages: readonly ChatMessage[], selfName: string) {
	return messages
		.map((m) =>
			m.role === "assistant"
				? `【${selfName}】${m.content ?? ""}`
				: (m.content ?? ""),
		)
		.join("\n");
}

/**
 * 当前话题的历史消息；需要时先压缩。检查点在最前，其后是未压缩的事件。
 */
export async function topicHistory(
	input: HistoryInput,
): Promise<ChatMessage[]> {
	const { s, topic, agent, nameOf, limits } = input;
	const all = await topicEvents(s, topic);
	let checkpoint = await latestCheckpoint(s, topic.id, agent.id);
	let pending = checkpoint
		? all.filter((e) => e.id > (checkpoint?.afterEventId ?? 0))
		: all;
	const estimate =
		estimateTokens(input.system) +
		estimateTokens(checkpoint?.summary) +
		messageTokens(historyMessages(pending, agent.id, nameOf));
	const overBudget = estimate > limits.windowTokens - limits.reserveTokens;
	if (overBudget || pending.length > limits.maxEvents) {
		const k = keepFrom(pending, agent.id, nameOf, limits);
		const older = pending.slice(0, k);
		const last = older.at(-1);
		if (last) {
			const summary = await summarize(
				input,
				checkpoint?.summary ?? null,
				older,
			);
			checkpoint = await s.insert(compactions, {
				topicId: topic.id,
				agentId: agent.id,
				summary,
				afterEventId: last.id,
			});
			pending = pending.slice(k);
		}
	}
	return [
		...(checkpoint
			? [
					{
						role: "user" as const,
						content: `${CHECKPOINT_PREFIX}\n${checkpoint.summary}`,
					},
				]
			: []),
		...historyMessages(pending, agent.id, nameOf),
	];
}

async function summarize(
	input: HistoryInput,
	previous: string | null,
	older: readonly Event[],
): Promise<string> {
	const messages = historyMessages(older, input.agent.id, input.nameOf);
	const body = [
		...(previous ? ["此前的检查点：", previous, ""] : []),
		"需要压缩的对话：",
		transcript(messages, input.nameOf(input.agent.id)),
	].join("\n");
	const res = await input.llm.complete({
		messages: [
			{ role: "system", content: CHECKPOINT_PROMPT },
			{ role: "user", content: body },
		],
		tools: [],
		meta: input.meta,
		trigger: {
			text: "",
			mentions: [],
			agent: input.agent,
			conversationKind: input.conversationKind,
			checkpoint: true,
		},
		signal: input.signal,
	});
	return res.text.trim() || "（无）";
}

// ─────────────────────────── 近期工作简报 ───────────────────────────

export const BRIEF_WINDOW_MS = 48 * 60 * 60 * 1000;
export const BRIEF_MAX_LINES = 10;
export const BRIEF_MAX_TOKENS = 350;
const BRIEF_LINE_CHARS = 40;
export const BRIEF_PREFIX =
	"【近期工作简报】你过去两天在其他话题里说的最后一句（仅供参考，不是新消息，不必回应）：";

const clipLine = (text: string) => {
	const chars = Array.from(text.replace(/\s+/g, " ").trim());
	return chars.length > BRIEF_LINE_CHARS
		? `${chars.slice(0, BRIEF_LINE_CHARS).join("")}…`
		: chars.join("");
};

/**
 * 该代理过去 48 小时在其他话题与会话里说的最后一句；`visibleTo` 给定时只列此人也在的会话。
 * 没有则 null。
 */
export async function recentWorkBrief(
	s: Scoped,
	input: {
		agentId: string;
		currentTopicId: string;
		visibleTo: string | null;
		now?: Date;
	},
): Promise<string | null> {
	const since = new Date((input.now ?? new Date()).getTime() - BRIEF_WINDOW_MS);
	const visible = input.visibleTo
		? s.executor
				.select({ id: conversationMembers.conversationId })
				.from(conversationMembers)
				.where(
					s.where(
						conversationMembers,
						eq(conversationMembers.principalId, input.visibleTo),
					),
				)
		: undefined;
	const rows = await s.executor
		.selectDistinctOn([events.topicId], {
			event: events,
			topicTitle: topics.title,
			topicMain: topics.isMain,
			conversationId: conversations.id,
			conversationKind: conversations.kind,
			conversationTitle: conversations.title,
		})
		.from(events)
		.innerJoin(topics, eq(topics.id, events.topicId))
		.innerJoin(conversations, eq(conversations.id, events.conversationId))
		.where(
			and(
				s.where(
					events,
					eq(events.actorId, input.agentId),
					eq(events.type, "message.posted"),
					ne(events.topicId, input.currentTopicId),
					gt(events.createdAt, since),
					visible ? inArray(events.conversationId, visible) : undefined,
				),
				s.where(topics),
				s.where(conversations, ne(conversations.kind, "negotiation")),
			),
		)
		.orderBy(events.topicId, desc(events.id));
	const latest = rows
		.sort((a, b) => b.event.id - a.event.id)
		.slice(0, BRIEF_MAX_LINES);
	if (latest.length === 0) return null;
	const labels = await conversationLabels(
		s,
		[...new Set(latest.map((r) => r.conversationId))],
		input.agentId,
	);
	const lines: string[] = [];
	let tokens = estimateTokens(BRIEF_PREFIX);
	for (const r of latest) {
		const e = toEvent(r.event);
		if (e.type !== "message.posted") continue;
		const where = r.topicMain
			? (labels.get(r.conversationId) ?? "会话")
			: `${labels.get(r.conversationId) ?? "会话"} · ${r.topicTitle}`;
		const line = `- 〔${where}〕${clipLine(e.payload.text)}`;
		const cost = estimateTokens(line);
		if (tokens + cost > BRIEF_MAX_TOKENS) break;
		lines.push(line);
		tokens += cost;
	}
	return lines.length > 0 ? [BRIEF_PREFIX, ...lines].join("\n") : null;
}

/** 会话的称呼：群名，或私聊里除该代理以外的人。 */
async function conversationLabels(
	s: Scoped,
	ids: readonly string[],
	agentId: string,
): Promise<Map<string, string>> {
	const convs = await s.select(
		conversations,
		inArray(conversations.id, [...ids]),
	);
	const members = await s.executor
		.select({
			conversationId: conversationMembers.conversationId,
			principalId: principals.id,
			kind: principals.kind,
			name: principals.displayName,
		})
		.from(conversationMembers)
		.innerJoin(principals, eq(principals.id, conversationMembers.principalId))
		.where(
			and(
				s.where(
					conversationMembers,
					inArray(conversationMembers.conversationId, [...ids]),
				),
				s.where(principals, eq(principals.kind, "human")),
			),
		);
	const out = new Map<string, string>();
	for (const c of convs) {
		if (c.kind === "group") {
			out.set(c.id, `群聊“${c.title ?? "群聊"}”`);
			continue;
		}
		const names = members
			.filter((m) => m.conversationId === c.id && m.principalId !== agentId)
			.map((m) => m.name);
		out.set(c.id, `与${names.join("、") || "本人"}的私聊`);
	}
	return out;
}
