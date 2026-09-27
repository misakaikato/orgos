/**
 * e2e 的场景框架与共用动作。
 *
 * 场景是一个函数，内部按子项调用 `step(子项, fn)`：通过打印"✓ 场景 · 子项"，
 * 断言失败抛 Mismatch（带期望与实际），由入口打印后以非 0 退出。
 * 等待一律轮询真实服务端的接口。直接碰库的只有三处：读 llm_requests（计量不经接口暴露）、
 * 读运行状态（判断会话是否已经安静下来）、把记忆提炼作业的执行时间提前（快进 10 分钟的去抖）。
 */
import type { ChildProcess } from "node:child_process";
import {
	type BrowserFrame,
	CreateConversationResponseSchema,
	ErrorBodySchema,
	type Event,
	EventsResponseSchema,
	type MeResponse,
	PostMessageResponseSchema,
	parseBrowserFrame,
	type WorkItem,
	WorkItemListResponseSchema,
	WorkItemResponseSchema,
} from "@orgos/protocol";
import {
	type Http,
	type Person,
	type Sql,
	until,
} from "@tests/process-harness";

// ─────────────────────────── 断言 ───────────────────────────

export class Mismatch extends Error {
	constructor(
		what: string,
		readonly expected: unknown,
		readonly actual: unknown,
	) {
		super(what);
	}
}

export function check(
	what: string,
	ok: boolean,
	expected: unknown,
	actual: unknown,
): void {
	if (!ok) throw new Mismatch(what, expected, actual);
}

export function equal<T>(what: string, actual: T, expected: T): void {
	check(what, Bun.deepEquals(actual, expected), expected, actual);
}

export function includes(what: string, text: string, part: string): void {
	check(what, text.includes(part), `含“${part}”`, text);
}

export function excludes(what: string, text: string, part: string): void {
	check(what, !text.includes(part), `不含“${part}”`, text);
}

/** 等待超时也算失败：期望是"等到"，实际是"超时"。 */
export async function waitFor<T>(
	what: string,
	fn: () => Promise<T | null | undefined | false>,
	timeoutMs = 15_000,
): Promise<T> {
	try {
		return await until(what, fn, timeoutMs);
	} catch {
		throw new Mismatch(what, `${timeoutMs / 1000} 秒内出现`, "超时");
	}
}

// ─────────────────────────── 场景 ───────────────────────────

export type Step = (item: string, fn: () => Promise<void>) => Promise<void>;

export type Scenario = {
	name: string;
	run(w: World, step: Step): Promise<void>;
};

export type Agent = { id: string; handle: string };

export type Member = {
	name: string;
	handle: string;
	id: string;
	tenantId: string;
	client: Http;
	/** 会话 token，浏览器 WS 以 `/ws?token=` 鉴权（与模拟台窗格同一条路）。 */
	token: string;
	me: MeResponse;
	twin: Agent;
	ops: Agent;
};

export type World = {
	base: string;
	sql: Sql;
	alice: Member;
	bob: Member;
	carol: Member;
	dave: Member;
	/** Runner 子进程共用的临时目录。 */
	runnerHome: string;
	workspace: string;
	/** 场景之间传递的会话与待办。 */
	ids: {
		/** alice 与 bob 的私聊（C2 建立，C3、C4、记忆、应用接口沿用）。 */
		pairDm: string;
		/** alice 与自己分身的私聊。 */
		aliceTwinDm: string;
		/** C3 里 alice 答复过的 decision 待办。 */
		decisionItem: string;
	};
	/** 设备场景之间传递的状态。 */
	device: {
		runnerId: string;
		token: string;
		child: ChildProcess | null;
		log: string;
	};
};

export function member(name: string, p: Person): Member {
	const { client, me, token } = p;
	const agent = (role: "front" | "specialist"): Agent => {
		const a = me.agents.find((x) => x.role === role);
		if (!a) throw new Error(`${name} 缺少 ${role} 代理`);
		return { id: a.principal.id, handle: a.principal.handle };
	};
	return {
		name,
		handle: me.principal.handle,
		id: me.principal.id,
		tenantId: me.tenant.id,
		client,
		token,
		me,
		twin: agent("front"),
		ops: agent("specialist"),
	};
}

// ─────────────────────────── 接口 ───────────────────────────

export async function expectStatus(
	what: string,
	res: Response,
	status: number,
): Promise<unknown> {
	const text = await res.text();
	check(
		what,
		res.status === status,
		`HTTP ${status}`,
		`HTTP ${res.status} ${text}`,
	);
	return text ? JSON.parse(text) : null;
}

export async function expectError(
	what: string,
	res: Response,
	status: number,
	code?: string,
): Promise<void> {
	const body = await expectStatus(what, res, status);
	if (code)
		equal(`${what}（错误码）`, ErrorBodySchema.parse(body).error.code, code);
}

export async function openDm(
	c: Http,
	withPrincipalId: string,
): Promise<string> {
	const res = await c.request("POST", "/api/conversations", {
		kind: "dm",
		withPrincipalId,
	});
	check("建私聊", [200, 201].includes(res.status), "HTTP 200/201", res.status);
	return CreateConversationResponseSchema.parse(await res.json()).conversation
		.id;
}

export async function openGroup(
	c: Http,
	title: string,
	memberIds: string[],
): Promise<string> {
	const body = await expectStatus(
		`建群“${title}”`,
		await c.request("POST", "/api/conversations", {
			kind: "group",
			title,
			memberIds,
		}),
		201,
	);
	return CreateConversationResponseSchema.parse(body).conversation.id;
}

export type MessageEvent = Extract<Event, { type: "message.posted" }>;

/** 发一条消息，返回落库的事件。 */
export async function post(
	c: Http,
	conversationId: string,
	text: string,
	opts: { mentions?: string[]; askTwin?: boolean; topicId?: string } = {},
): Promise<MessageEvent> {
	const body = await expectStatus(
		`发消息“${text}”`,
		await c.request("POST", `/api/conversations/${conversationId}/messages`, {
			text,
			...opts,
		}),
		201,
	);
	const { event } = PostMessageResponseSchema.parse(body);
	if (event.type !== "message.posted") throw new Error("不是消息事件");
	return event;
}

/** 某个话题（缺省主线）的事件，按 seq。 */
export async function events(
	c: Http,
	conversationId: string,
	topicId?: string,
): Promise<Event[]> {
	const q = topicId ? `&topicId=${topicId}` : "";
	const res = await c.request(
		"GET",
		`/api/conversations/${conversationId}/events?limit=200${q}`,
	);
	check("读事件", res.status === 200, "HTTP 200", res.status);
	return EventsResponseSchema.parse(await res.json()).items;
}

export function messagesBy(list: readonly Event[], actorId: string) {
	return list.filter(
		(e): e is MessageEvent =>
			e.type === "message.posted" && e.actorId === actorId,
	);
}

/** 等某个事件出现在 after 之后（事件 id 递增）。 */
export async function eventAfter<E extends Event>(
	what: string,
	c: Http,
	conversationId: string,
	after: number,
	match: (e: Event) => e is E,
	opts: { topicId?: string; timeoutMs?: number } = {},
): Promise<E> {
	return waitFor(
		what,
		async () =>
			(await events(c, conversationId, opts.topicId)).find(
				(e): e is E => e.id > after && match(e),
			),
		opts.timeoutMs,
	);
}

/** 等某个代理在 after 之后发出的第一条消息。 */
export function replyFrom(
	c: Http,
	conversationId: string,
	agent: Agent,
	after: number,
	opts: { topicId?: string; timeoutMs?: number } = {},
): Promise<MessageEvent> {
	return eventAfter(
		`${agent.handle} 的回复`,
		c,
		conversationId,
		after,
		(e): e is MessageEvent =>
			e.type === "message.posted" && e.actorId === agent.id,
		opts,
	);
}

/**
 * 等会话安静下来：库里该会话没有进行中的运行，且事件数连续两次读取不变。
 * 用在"某代理不该开口"这类否定断言之前。
 */
export async function settle(
	w: Pick<World, "sql">,
	c: Http,
	conversationId: string,
	topicId?: string,
): Promise<Event[]> {
	let last = -1;
	return waitFor(`会话 ${conversationId} 安静下来`, async () => {
		await new Promise((r) => setTimeout(r, 300));
		const [row] = await w.sql<{ n: number }[]>`
			select count(*)::int as n from runs
			where conversation_id = ${conversationId} and state = 'running'`;
		const list = await events(c, conversationId, topicId);
		const stable = row?.n === 0 && list.length === last;
		last = list.length;
		return stable ? list : null;
	});
}

/** 在 ms 毫秒内不应出现满足条件的事件。 */
export async function quiet(
	what: string,
	c: Http,
	conversationId: string,
	after: number,
	match: (e: Event) => boolean,
	ms: number,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const hit = (await events(c, conversationId)).find(
			(e) => e.id > after && match(e),
		);
		check(what, !hit, `${ms / 1000} 秒内没有`, hit);
		await new Promise((r) => setTimeout(r, 250));
	}
}

export async function setStatus(
	m: Member,
	status: "available" | "busy" | "away",
): Promise<void> {
	await expectStatus(
		`${m.name} 状态设为 ${status}`,
		await m.client.request("PATCH", "/api/me/status", { status }),
		200,
	);
}

export async function openItems(m: Member): Promise<WorkItem[]> {
	const res = await m.client.request("GET", "/api/work-items?status=open");
	check("读待办", res.status === 200, "HTTP 200", res.status);
	return WorkItemListResponseSchema.parse(await res.json()).items;
}

/** 等某人出现一条满足条件的 open 待办。 */
export function openItem(
	what: string,
	m: Member,
	match: (w: WorkItem) => boolean,
): Promise<WorkItem> {
	return waitFor(what, async () => (await openItems(m)).find(match));
}

export async function resolveItem(
	m: Member,
	id: string,
	body: Record<string, unknown>,
): Promise<WorkItem> {
	const res = await expectStatus(
		`${m.name} 处理待办（${String(body.action)}）`,
		await m.client.request("POST", `/api/work-items/${id}/resolve`, body),
		200,
	);
	return WorkItemResponseSchema.parse(res).workItem;
}

/** 某会话里的模型调用行数（计量只在库里）。 */
export async function llmRequestCount(
	w: Pick<World, "sql">,
	conversationId: string,
): Promise<number> {
	const [row] = await w.sql<{ n: number }[]>`
		select count(*)::int as n from llm_requests where conversation_id = ${conversationId}`;
	return row?.n ?? 0;
}

// ─────────────────────────── 浏览器 WS ───────────────────────────

export type Listener = {
	frames: BrowserFrame[];
	close(): void;
};

/** 以某人的会话 token 连 /ws，收集推给他的帧。 */
export async function listen(m: Member): Promise<Listener> {
	const base = m.client.base.replace(/^http/, "ws");
	const ws = new WebSocket(`${base}/ws?token=${encodeURIComponent(m.token)}`);
	const frames: BrowserFrame[] = [];
	ws.addEventListener("message", (e) => {
		const parsed = parseBrowserFrame(String(e.data));
		if (parsed.ok) frames.push(parsed.data);
	});
	await waitFor(
		`${m.name} 的 WS 连上`,
		async () => ws.readyState === WebSocket.OPEN,
		5_000,
	);
	// 服务端在升级完成后才把连接登记到推送中心。
	await new Promise((r) => setTimeout(r, 200));
	return { frames, close: () => ws.close() };
}
