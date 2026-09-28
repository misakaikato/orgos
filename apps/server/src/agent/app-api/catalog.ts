/**
 * 应用接口目录：Hono 应用实际注册的每一个接口在这里登记一行——用途、风险级别、入参 schema。
 * 接口本身是唯一的真相：入参直接引用 `@orgos/protocol` 里路由校验用的同一个 Zod schema，
 * 目录只补说明与风险级别。完整性由测试保证（遍历应用的全部路由，两边必须一一对应）。
 */
import {
	AddMemberRequestSchema,
	AddUnitMemberRequestSchema,
	CorrectAnswerRequestSchema,
	CreateAgentRequestSchema,
	CreateConversationRequestSchema,
	CreateModelGroupRequestSchema,
	CreateModelProviderRequestSchema,
	CreateNoteRequestSchema,
	CreateTaskRequestSchema,
	CreateTopicRequestSchema,
	CreateUnitNoteRequestSchema,
	CreateUnitRequestSchema,
	EventsQuerySchema,
	MarkReadRequestSchema,
	MemoryItemsQuerySchema,
	MemoryUnitQuerySchema,
	PostMessageRequestSchema,
	ProviderTestRequestSchema,
	ResolveWorkItemRequestSchema,
	RunsQuerySchema,
	StopQuerySchema,
	TaskLogQuerySchema,
	TasksQuerySchema,
	TopicToGroupRequestSchema,
	TopicToTaskRequestSchema,
	UpdateAgentRequestSchema,
	UpdateDisclosureRequestSchema,
	UpdateMemoryItemRequestSchema,
	UpdateModelGroupRequestSchema,
	UpdateModelProviderRequestSchema,
	UpdateNoteRequestSchema,
	UpdateStatusRequestSchema,
	UpdateTenantSettingsRequestSchema,
	UpdateTopicRequestSchema,
	UpdateUnitNoteRequestSchema,
	UpdateUnitRequestSchema,
	WithholdAnswerRequestSchema,
	WorkItemsQuerySchema,
} from "@orgos/protocol";
import type { z } from "zod";

export const API_RISKS = [
	"public_read",
	"private_read",
	"social_write",
	"self_write",
	"admin_write",
	"excluded",
] as const;
export type ApiRisk = (typeof API_RISKS)[number];

export const API_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
export type ApiMethod = (typeof API_METHODS)[number];

export type ApiEntry = {
	/** 与 Hono 注册时一致；`ALL` 表示任意方法。 */
	method: ApiMethod | "ALL";
	/** Hono 的路由模式（`:id` 参数、`*` 通配）。 */
	path: string;
	/** 一句中文用途（检索用，写上常见说法）。 */
	purpose: string;
	risk: ApiRisk;
	body?: z.ZodType;
	query?: z.ZodType;
};

const RISK_NOTE: Record<ApiRisk, string> = {
	public_read: "公开信息",
	private_read: "本人私有数据",
	social_write: "别人看得到的写操作",
	self_write: "只影响本人",
	admin_write: "租户管理",
	excluded: "不开放给代理",
};

export function riskNote(risk: ApiRisk): string {
	return RISK_NOTE[risk];
}

type Row = [
	method: ApiEntry["method"],
	path: string,
	risk: ApiRisk,
	purpose: string,
	schemas?: { body?: z.ZodType; query?: z.ZodType },
];

/** 按注册顺序登记；两条兜底路由（未命中的 /api、反代前端）放在最后。 */
const ROWS: Row[] = [
	["GET", "/healthz", "excluded", "进程探活（运维用）"],
	["GET", "/api/auth/*", "excluded", "登录鉴权"],
	["POST", "/api/auth/*", "excluded", "登录鉴权"],
	["POST", "/api/onboarding", "excluded", "引导：建租户或加入租户"],

	["GET", "/api/me", "private_read", "我的身份、所在租户与我的代理列表"],
	[
		"PATCH",
		"/api/me/status",
		"self_write",
		"改我的在线状态（在线 available / 忙碌 busy / 离开 away）",
		{ body: UpdateStatusRequestSchema },
	],
	[
		"GET",
		"/api/directory",
		"public_read",
		"通讯录：同事列表（人名、handle、主体 id、在线状态、各自的分身），找人、查某人的 id",
	],

	[
		"GET",
		"/api/conversations",
		"private_read",
		"我的会话列表（私聊与群聊，含成员、未读、最近消息）",
	],
	[
		"POST",
		"/api/conversations",
		"social_write",
		"建群聊（拉群，kind=group，给群名与成员 id，各人的分身随本人入群）或打开与某人的私聊（kind=dm）",
		{ body: CreateConversationRequestSchema },
	],
	[
		"GET",
		"/api/conversations/:id/events",
		"private_read",
		"读某个会话的消息与事件记录（聊天记录）",
		{ query: EventsQuerySchema },
	],
	[
		"POST",
		"/api/conversations/:id/messages",
		"social_write",
		"在会话里发一条消息（format 可选 text 纯文本、md Markdown、html 网页片段）",
		{ body: PostMessageRequestSchema },
	],
	[
		"POST",
		"/api/conversations/:id/members",
		"social_write",
		"把人加进群聊（拉人进群，分身随本人入群）",
		{ body: AddMemberRequestSchema },
	],
	[
		"POST",
		"/api/conversations/:id/read",
		"self_write",
		"把会话标为已读到某条",
		{ body: MarkReadRequestSchema },
	],
	[
		"DELETE",
		"/api/conversations/:id/members/:principalId",
		"social_write",
		"把人移出群聊，或自己退群",
	],
	[
		"POST",
		"/api/conversations/:id/stop",
		"social_write",
		"停止会话（或其中一个话题）里正在进行的代理运行",
		{ query: StopQuerySchema },
	],

	[
		"GET",
		"/api/work-items",
		"private_read",
		"我的待办（上报给我的问题、要我确认或批准的事）",
		{ query: WorkItemsQuerySchema },
	],
	[
		"POST",
		"/api/work-items/:id/resolve",
		"social_write",
		"处理一条待办：答复上报、确认协商结果、批准或拒绝设备操作",
		{ body: ResolveWorkItemRequestSchema },
	],

	[
		"GET",
		"/api/agents",
		"private_read",
		"我的代理列表（分身、执行助手、专员）",
	],
	[
		"POST",
		"/api/agents",
		"self_write",
		"给自己新建一个代理（专员或外部助手）",
		{ body: CreateAgentRequestSchema },
	],
	[
		"PATCH",
		"/api/agents/:id",
		"self_write",
		"改我的代理：名字、职责、对外政策、模型、绑定设备",
		{ body: UpdateAgentRequestSchema },
	],
	["DELETE", "/api/agents/:id", "self_write", "删除我的一个代理"],
	["GET", "/api/usage", "private_read", "我的代理的模型用量与花费"],

	["GET", "/api/notes", "private_read", "我的资料（笔记）列表"],
	[
		"POST",
		"/api/notes",
		"self_write",
		"写一条我的资料（私有或共享给分身对外使用）",
		{ body: CreateNoteRequestSchema },
	],
	[
		"PATCH",
		"/api/notes/:id",
		"self_write",
		"改我的一条资料",
		{ body: UpdateNoteRequestSchema },
	],
	["DELETE", "/api/notes/:id", "self_write", "删除我的一条资料"],

	[
		"GET",
		"/api/memory/items",
		"private_read",
		"浏览、搜索我的记忆条目",
		{ query: MemoryItemsQuerySchema },
	],
	[
		"PATCH",
		"/api/memory/items/:id",
		"self_write",
		"编辑我的一条记忆",
		{ body: UpdateMemoryItemRequestSchema, query: MemoryUnitQuerySchema },
	],
	[
		"POST",
		"/api/memory/items/:id/retract",
		"self_write",
		"撤回我的一条记忆",
		{ query: MemoryUnitQuerySchema },
	],
	[
		"GET",
		"/api/memory/items/:id/sources",
		"private_read",
		"一条记忆的出处（我在的会话里的原消息）",
	],
	[
		"GET",
		"/api/memory/disclosure",
		"private_read",
		"我的记忆哪些类别允许分身对外说",
		{ query: MemoryUnitQuerySchema },
	],
	[
		"PUT",
		"/api/memory/disclosure",
		"self_write",
		"设置某类记忆是否允许分身对外说",
		{ body: UpdateDisclosureRequestSchema, query: MemoryUnitQuerySchema },
	],
	[
		"GET",
		"/api/memory/answers",
		"private_read",
		"分身替我回答别人的代答记录",
		{ query: MemoryUnitQuerySchema },
	],
	[
		"POST",
		"/api/memory/answers/:eventId/correct",
		"social_write",
		"更正分身的一条代答（对方会看到更正）",
		{ body: CorrectAnswerRequestSchema, query: MemoryUnitQuerySchema },
	],
	[
		"POST",
		"/api/memory/answers/:eventId/withhold",
		"self_write",
		"把分身的一条代答标为不许对外说",
		{ body: WithholdAnswerRequestSchema, query: MemoryUnitQuerySchema },
	],

	[
		"GET",
		"/api/org",
		"public_read",
		"组织结构：部门（单元）树、负责人、成员、部门分身",
	],
	[
		"POST",
		"/api/org/units",
		"admin_write",
		"新建部门（仅租户管理员）",
		{ body: CreateUnitRequestSchema },
	],
	[
		"GET",
		"/api/org/units/:id",
		"private_read",
		"部门页：章程、成员、部门资料、最近决定",
	],
	[
		"PATCH",
		"/api/org/units/:id",
		"admin_write",
		"改部门：名称、负责人、章程、上级部门",
		{ body: UpdateUnitRequestSchema },
	],
	[
		"POST",
		"/api/org/units/:id/members",
		"admin_write",
		"把人加进部门",
		{ body: AddUnitMemberRequestSchema },
	],
	[
		"DELETE",
		"/api/org/units/:id/members/:principalId",
		"admin_write",
		"把人移出部门",
	],
	[
		"POST",
		"/api/org/units/:id/notes",
		"social_write",
		"新增一条部门资料",
		{ body: CreateUnitNoteRequestSchema },
	],
	[
		"PATCH",
		"/api/org/units/:id/notes/:noteId",
		"social_write",
		"改一条部门资料",
		{ body: UpdateUnitNoteRequestSchema },
	],
	[
		"DELETE",
		"/api/org/units/:id/notes/:noteId",
		"social_write",
		"删除一条部门资料",
	],

	["POST", "/api/runners/pair", "excluded", "设备配对（签发设备凭据）"],
	["POST", "/api/runners/pairing-codes", "excluded", "签发设备配对码（凭据）"],
	["GET", "/api/runners", "private_read", "我的设备列表"],
	["DELETE", "/api/runners/:id", "self_write", "吊销我的一台设备"],
	["GET", "/runner/ws", "excluded", "设备长连接"],

	[
		"GET",
		"/api/tasks",
		"private_read",
		"任务列表（交给代理的活）",
		{ query: TasksQuerySchema },
	],
	[
		"POST",
		"/api/tasks",
		"social_write",
		"把一件活交给代理，建成任务",
		{ body: CreateTaskRequestSchema },
	],
	["GET", "/api/tasks/:id", "private_read", "一个任务的详情"],
	[
		"GET",
		"/api/tasks/:id/log",
		"private_read",
		"一个任务的过程记录",
		{ query: TaskLogQuerySchema },
	],
	["POST", "/api/tasks/:id/complete", "social_write", "把任务标为完成"],
	["POST", "/api/tasks/:id/cancel", "social_write", "停止（取消）任务"],

	[
		"GET",
		"/api/conversations/:id/topics",
		"private_read",
		"一个会话里的话题列表",
	],
	[
		"POST",
		"/api/conversations/:id/topics",
		"social_write",
		"在会话里开一个新话题",
		{ body: CreateTopicRequestSchema },
	],
	[
		"PATCH",
		"/api/topics/:id",
		"social_write",
		"改话题：改名、归档",
		{ body: UpdateTopicRequestSchema },
	],
	[
		"POST",
		"/api/topics/:id/to-task",
		"social_write",
		"把话题转成交给代理的任务",
		{ body: TopicToTaskRequestSchema },
	],
	[
		"POST",
		"/api/topics/:id/to-group",
		"social_write",
		"把话题转成一个新群聊",
		{ body: TopicToGroupRequestSchema },
	],
	[
		"GET",
		"/api/topics/:id/source",
		"private_read",
		"话题的来源（从哪个会话转来）",
	],

	[
		"GET",
		"/api/runs",
		"private_read",
		"代理的运行记录列表",
		{ query: RunsQuerySchema },
	],
	["GET", "/api/runs/:id", "private_read", "一次运行的详情与过程"],

	["GET", "/api/tenant/settings", "private_read", "租户设置"],
	[
		"PATCH",
		"/api/tenant/settings",
		"admin_write",
		"改租户设置（仅租户管理员）",
		{ body: UpdateTenantSettingsRequestSchema },
	],

	[
		"GET",
		"/api/models",
		"public_read",
		"可选的模型列表（给代理选模型）与默认模型",
	],
	[
		"GET",
		"/api/model-admin",
		"private_read",
		"模型厂商与路由组的管理视图（仅租户管理员）",
	],
	[
		"POST",
		"/api/model-providers",
		"admin_write",
		"接入一个模型厂商",
		{ body: CreateModelProviderRequestSchema },
	],
	[
		"PATCH",
		"/api/model-providers/:id",
		"admin_write",
		"改模型厂商",
		{ body: UpdateModelProviderRequestSchema },
	],
	["DELETE", "/api/model-providers/:id", "admin_write", "删除模型厂商"],
	[
		"GET",
		"/api/model-providers/:id/models",
		"private_read",
		"拉取某厂商的模型列表（仅租户管理员）",
	],
	[
		"POST",
		"/api/model-providers/:id/test",
		"admin_write",
		"测试模型厂商连通性",
		{ body: ProviderTestRequestSchema },
	],
	[
		"POST",
		"/api/model-groups",
		"admin_write",
		"新建模型路由组",
		{ body: CreateModelGroupRequestSchema },
	],
	[
		"PATCH",
		"/api/model-groups/:id",
		"admin_write",
		"改模型路由组",
		{ body: UpdateModelGroupRequestSchema },
	],
	["DELETE", "/api/model-groups/:id", "admin_write", "删除模型路由组"],

	["POST", "/llm/v1/chat/completions", "excluded", "企业模型网关"],
	["POST", "/llm/v1/responses", "excluded", "企业模型网关"],
	["POST", "/llm/v1/messages", "excluded", "企业模型网关"],
	["GET", "/llm/v1/models", "excluded", "企业模型网关"],
	["ALL", "/llm/*", "excluded", "企业模型网关"],
	["GET", "/ws", "excluded", "浏览器长连接"],

	["GET", "/api/dev/info", "excluded", "开发调试"],
	["GET", "/api/dev/people", "excluded", "开发调试"],
	["POST", "/api/dev/sessions", "excluded", "开发调试：签发演示会话"],
	["POST", "/api/dev/reset-demo", "excluded", "开发调试：重置演示数据"],

	["ALL", "/api/*", "excluded", "未登记的接口"],
	["ALL", "/*", "excluded", "前端页面"],
];

export const API_CATALOG: readonly ApiEntry[] = ROWS.map(
	([method, path, risk, purpose, schemas]) => ({
		method,
		path,
		risk,
		purpose,
		...schemas,
	}),
);

export const entryKey = (e: Pick<ApiEntry, "method" | "path">) =>
	`${e.method} ${e.path}`;

function patternOf(path: string): RegExp {
	const body = path
		.split("/")
		.map((seg) =>
			seg === "*"
				? ".*"
				: seg.startsWith(":")
					? `(?<${seg.slice(1)}>[^/]+)`
					: seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		)
		.join("/");
	return new RegExp(`^${body}$`);
}

const PATTERNS = new Map(API_CATALOG.map((e) => [e, patternOf(e.path)]));

export type EntryMatch = { entry: ApiEntry; params: Record<string, string> };

/** 按登记顺序找第一个匹配的接口（兜底路由在最后）；路径须已规范化（不含查询串）。 */
export function matchEntry(method: ApiMethod, path: string): EntryMatch | null {
	for (const entry of API_CATALOG) {
		if (entry.method !== "ALL" && entry.method !== method) continue;
		const m = PATTERNS.get(entry)?.exec(path);
		if (m) return { entry, params: { ...m.groups } };
	}
	return null;
}

const SPLIT = /[\s,，。；;、：:？?！!（）()/]+/;

/** 一个检索词对一段文本的得分：整词命中 10 分，否则按字（中文）或词（英文）的命中比例。 */
function termScore(term: string, text: string): number {
	if (text.includes(term)) return 10;
	const chars = [...new Set(Array.from(term))];
	const hit = chars.filter((ch) => text.includes(ch)).length;
	return chars.length > 0 ? (hit / chars.length) * 3 : 0;
}

export const SEARCH_LIMIT = 8;

/** 在给定的接口里按关键词取最相关的至多 8 个。 */
export function searchEntries(
	entries: readonly ApiEntry[],
	query: string,
): ApiEntry[] {
	const terms = query.toLowerCase().split(SPLIT).filter(Boolean);
	if (terms.length === 0) return [];
	return entries
		.map((e, i) => {
			const text = `${e.method} ${e.path} ${e.purpose}`.toLowerCase();
			const score = terms.reduce((sum, t) => sum + termScore(t, text), 0);
			return { e, i, score };
		})
		.filter((x) => x.score >= 1)
		.sort((a, b) => b.score - a.score || a.i - b.i)
		.slice(0, SEARCH_LIMIT)
		.map((x) => x.e);
}
