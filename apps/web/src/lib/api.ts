/**
 * 服务端 REST 的唯一访问入口。出入参类型与校验全部来自 @orgos/protocol。
 */
import {
	type AddMemberRequest,
	AgentListResponseSchema,
	AgentResponseSchema,
	ConversationListResponseSchema,
	type CreateAgentRequest,
	type CreateConversationRequest,
	CreateConversationResponseSchema,
	type CreateNoteRequest,
	DemoPeopleResponseSchema,
	DevInfoResponseSchema,
	DevSessionResponseSchema,
	DirectoryResponseSchema,
	ErrorBodySchema,
	EVENTS_PAGE_MAX,
	type Event,
	EventsResponseSchema,
	MeResponseSchema,
	NoteListResponseSchema,
	NoteResponseSchema,
	type OnboardingRequest,
	OnboardingResponseSchema,
	type PostMessageRequest,
	PostMessageResponseSchema,
	ResetDemoResponseSchema,
	type ResolveWorkItemRequest,
	type UpdateAgentRequest,
	type UpdateNoteRequest,
	type UpdateStatusRequest,
	UpdateStatusResponseSchema,
	UsageResponseSchema,
	type WORK_ITEM_STATUSES,
	WorkItemListResponseSchema,
	WorkItemResponseSchema,
} from "@orgos/protocol";
import ky, { HTTPError, type ResponsePromise } from "ky";
import { authHeaders } from "@/lib/auth-mode";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

const http = ky.create({
	retry: 0,
	timeout: 15_000,
	hooks: {
		beforeRequest: [
			({ request }) => {
				const headers = authHeaders();
				if (Object.keys(headers).length === 0) return;
				// bearer 模式不带 cookie：同源窗格的 cookie 属于另一个身份。
				const next = new Request(request, { credentials: "omit" });
				for (const [k, v] of Object.entries(headers)) next.headers.set(k, v);
				return next;
			},
		],
	},
});

/** 服务端错误体是 `{ error: { code, message } }`；better-auth 的是 `{ code, message }`。 */
function toApiError(e: unknown): unknown {
	if (!(e instanceof HTTPError)) return e;
	const status = e.response.status;
	const data: unknown = e.data;
	const ours = ErrorBodySchema.safeParse(data);
	if (ours.success) {
		return new ApiError(status, ours.data.error.code, ours.data.error.message);
	}
	if (data && typeof data === "object" && "message" in data) {
		const { message, code } = data as { message?: unknown; code?: unknown };
		return new ApiError(
			status,
			typeof code === "string" ? code : `HTTP_${status}`,
			typeof message === "string" ? message : `请求失败（${status}）`,
		);
	}
	return new ApiError(status, `HTTP_${status}`, `请求失败（${status}）`);
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		throw toApiError(e);
	}
}

async function noContent(p: ResponsePromise): Promise<void> {
	await run(() => p);
}

export const api = {
	signIn: (email: string, password: string) =>
		noContent(
			http.post("/api/auth/sign-in/email", { json: { email, password } }),
		),
	signUp: (name: string, email: string, password: string) =>
		noContent(
			http.post("/api/auth/sign-up/email", { json: { name, email, password } }),
		),
	signOut: () => noContent(http.post("/api/auth/sign-out", { json: {} })),

	onboarding: (req: OnboardingRequest) =>
		run(() =>
			http
				.post("/api/onboarding", { json: req })
				.json(OnboardingResponseSchema),
		),
	me: () => run(() => http.get("/api/me").json(MeResponseSchema)),
	directory: () =>
		run(() => http.get("/api/directory").json(DirectoryResponseSchema)),
	updateStatus: (req: UpdateStatusRequest) =>
		run(() =>
			http
				.patch("/api/me/status", { json: req })
				.json(UpdateStatusResponseSchema),
		),

	conversations: () =>
		run(() =>
			http.get("/api/conversations").json(ConversationListResponseSchema),
		),
	createConversation: (req: CreateConversationRequest) =>
		run(() =>
			http
				.post("/api/conversations", { json: req })
				.json(CreateConversationResponseSchema),
		),
	events: (id: string, after: number, limit = EVENTS_PAGE_MAX) =>
		run(() =>
			http
				.get(`/api/conversations/${id}/events`, {
					searchParams: { after, limit },
				})
				.json(EventsResponseSchema),
		),
	postMessage: (id: string, req: PostMessageRequest) =>
		run(() =>
			http
				.post(`/api/conversations/${id}/messages`, { json: req })
				.json(PostMessageResponseSchema),
		),
	addMember: (id: string, req: AddMemberRequest) =>
		noContent(http.post(`/api/conversations/${id}/members`, { json: req })),
	markRead: (id: string, seq: number) =>
		noContent(http.post(`/api/conversations/${id}/read`, { json: { seq } })),
	/** 中止该会话里正在运行的代理。 */
	stop: (id: string) => noContent(http.post(`/api/conversations/${id}/stop`)),

	agents: () =>
		run(() => http.get("/api/agents").json(AgentListResponseSchema)),
	createAgent: (req: CreateAgentRequest) =>
		run(() =>
			http.post("/api/agents", { json: req }).json(AgentResponseSchema),
		),
	updateAgent: (id: string, req: UpdateAgentRequest) =>
		run(() =>
			http.patch(`/api/agents/${id}`, { json: req }).json(AgentResponseSchema),
		),
	deleteAgent: (id: string) => noContent(http.delete(`/api/agents/${id}`)),
	usage: () => run(() => http.get("/api/usage").json(UsageResponseSchema)),

	notes: () => run(() => http.get("/api/notes").json(NoteListResponseSchema)),
	createNote: (req: CreateNoteRequest) =>
		run(() => http.post("/api/notes", { json: req }).json(NoteResponseSchema)),
	updateNote: (id: string, req: UpdateNoteRequest) =>
		run(() =>
			http.patch(`/api/notes/${id}`, { json: req }).json(NoteResponseSchema),
		),
	deleteNote: (id: string) => noContent(http.delete(`/api/notes/${id}`)),

	/** 我是处理人的待办；`as` 给定时以该 bearer 身份请求（模拟台读各窗格的待办数）。 */
	workItems: (
		status: (typeof WORK_ITEM_STATUSES)[number] = "open",
		as?: string,
	) =>
		run(() =>
			http
				.get("/api/work-items", {
					searchParams: { status },
					...(as ? { headers: authHeaders(as), credentials: "omit" } : {}),
				})
				.json(WorkItemListResponseSchema),
		),
	resolveWorkItem: (id: string, req: ResolveWorkItemRequest) =>
		run(() =>
			http
				.post(`/api/work-items/${id}/resolve`, { json: req })
				.json(WorkItemResponseSchema),
		),
};

/** 模拟台接口（仅 ORGOS_DEV=1 时存在）。 */
export const devApi = {
	info: () => run(() => http.get("/api/dev/info").json(DevInfoResponseSchema)),
	people: () =>
		run(() => http.get("/api/dev/people").json(DemoPeopleResponseSchema)),
	session: (handle: string) =>
		run(() =>
			http
				.post("/api/dev/sessions", { json: { handle } })
				.json(DevSessionResponseSchema),
		),
	resetDemo: () =>
		run(() =>
			http
				.post("/api/dev/reset-demo", { timeout: 60_000 })
				.json(ResetDemoResponseSchema),
		),
};

/** 拉取 `after` 之后的全部事件（按页取到不足一页为止）。 */
export async function fetchEventsAfter(
	id: string,
	after: number,
): Promise<Event[]> {
	const all: Event[] = [];
	let cursor = after;
	for (;;) {
		const { items } = await api.events(id, cursor);
		all.push(...items);
		const last = items.at(-1);
		if (items.length < EVENTS_PAGE_MAX || !last?.seq) return all;
		cursor = last.seq;
	}
}
