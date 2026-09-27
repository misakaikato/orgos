/**
 * 应用接口工具：代理调用 orgos 本身的 REST 接口。
 *
 * - `app_api_search`：按关键词在接口目录里找本次能调用的接口（整份目录不进系统提示）；
 * - `app_api_call`：在进程内调用同一个 Hono 应用。请求者是代理的本人，内部上下文经 env 传入，
 *   鉴权、成员校验、租户作用域与权限检查全部照常走接口本身；写下的事件由 events.ts 记为代理代办。
 *
 * 可用性：只给个人代理，协商会话里不给。为本人办事时开放全部非 excluded 接口；
 * 替他人 R 办事时只开放 public_read，以及三个低风险动作（建包含 R 的群、在 R 也在的会话里开话题、
 * 把人加进 R 也在的群），参数在这里硬性检查，其余一律拒绝并提示转给本人。
 */
import {
	AddMemberRequestSchema,
	CreateConversationRequestSchema,
	CreateTopicRequestSchema,
} from "@orgos/protocol";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	API_CATALOG,
	API_METHODS,
	type ApiEntry,
	type ApiMethod,
	type EntryMatch,
	entryKey,
	matchEntry,
	riskNote,
	searchEntries,
} from "@/agent/app-api/catalog";
import { makeTool, type ToolOutcome, type ToolScope } from "@/agent/tools/tool";
import { conversations } from "@/db/schema";
import { isUuid } from "@/lib/uuid";
import { internalCallEnv } from "@/middleware/auth";
import { memberPrincipals } from "@/services/conversations";
import { appendTaskLog } from "@/services/tasks";

/** 个人代理、非协商会话。 */
export function appApiAvailable(scope: ToolScope): boolean {
	return (
		scope.unit === null &&
		scope.owner.kind === "human" &&
		scope.conversation.kind !== "negotiation"
	);
}

/** 替他人 R 办事时仍可做的三个动作，以及各自对参数的要求（给模型看的说明）。 */
const LOW_RISK: Record<string, string> = {
	"POST /api/conversations": "只能建群（kind=group），成员必须包含提问的人",
	"POST /api/conversations/:id/topics": "只能在提问的人也在的会话里开话题",
	"POST /api/conversations/:id/members": "只能把人加进提问的人也在的群",
};

function openForOther(entry: ApiEntry): boolean {
	return entry.risk === "public_read" || entryKey(entry) in LOW_RISK;
}

/** 本次运行能调用的接口。 */
function callableEntries(scope: ToolScope): ApiEntry[] {
	return API_CATALOG.filter(
		(e) =>
			e.risk !== "excluded" &&
			e.method !== "ALL" &&
			(scope.actingFor.kind === "owner" || openForOther(e)),
	);
}

const toSchema = (schema: z.ZodType) => {
	const { $schema: _, ...json } = z.toJSONSchema(schema, {
		io: "input",
		unrepresentable: "any",
	});
	return JSON.stringify(json);
};

function describeEntry(e: ApiEntry, scope: ToolScope): string {
	const lines = [`${e.method} ${e.path}：${e.purpose}（${riskNote(e.risk)}）`];
	const limit = LOW_RISK[entryKey(e)];
	if (scope.actingFor.kind === "other" && limit)
		lines.push(`  替人办事时的限制：${limit}`);
	if (e.query) lines.push(`  query：${toSchema(e.query)}`);
	if (e.body) lines.push(`  body：${toSchema(e.body)}`);
	return lines.join("\n");
}

export const appApiSearchTool = makeTool({
	name: "app_api_search",
	description:
		"在 orgos 的接口目录里按关键词找接口（例如“建群”“通讯录”“待办”“话题”），返回最相关的至多 8 个：方法、路径、用途与入参 schema。调用 app_api_call 之前先用它找接口。",
	label: "正在查找接口…",
	schema: z.object({ query: z.string().trim().min(1).max(200) }),
	available: appApiAvailable,
	run: async ({ query }, scope) => {
		const found = searchEntries(callableEntries(scope), query);
		if (found.length === 0)
			return {
				result: "无结果：换个关键词再找，或者这件事没有对应的接口",
				summary: `查找接口“${query}”：无结果`,
				ok: true,
			};
		return {
			result: found.map((e) => describeEntry(e, scope)).join("\n"),
			summary: `查找接口“${query}”：${found.length} 个`,
			ok: true,
		};
	},
});

const BASE = "http://orgos.internal";
const RESPONSE_LIMIT = 4000;

const CallSchema = z.object({
	method: z.enum(API_METHODS),
	path: z
		.string()
		.trim()
		.min(1)
		.max(500)
		.describe(
			"接口路径，参数替换成实际值，例如 /api/conversations/<会话 id>/topics",
		),
	query: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.optional(),
	body: z.unknown().optional().describe("JSON 请求体"),
});
type CallArgs = z.infer<typeof CallSchema>;

const refuse = (result: string, summary: string): ToolOutcome => ({
	result,
	summary,
	ok: false,
});

/** 规范化路径：只接受本应用内的绝对路径，不接受编码字符（Hono 会先解码再路由）。 */
function resolveUrl(args: CallArgs): URL | null {
	if (!args.path.startsWith("/") || /[%\\#]/.test(args.path)) return null;
	const url = new URL(args.path, BASE);
	if (url.origin !== BASE) return null;
	for (const [k, v] of Object.entries(args.query ?? {}))
		url.searchParams.set(k, String(v));
	return url;
}

/** 替他人 R 办事时三个低风险动作的参数检查；通过返回 null，否则返回拒绝原因。 */
async function otherLimit(
	scope: ToolScope,
	requesterId: string,
	{ entry, params }: EntryMatch,
	body: unknown,
): Promise<string | null> {
	if (entry.risk === "public_read") return null;
	const key = entryKey(entry);
	if (key === "POST /api/conversations") {
		const req = CreateConversationRequestSchema.safeParse(body);
		if (!req.success) return "请求体不合法";
		if (req.data.kind !== "group") return "只能建群，不能替本人开私聊";
		return req.data.memberIds.includes(requesterId)
			? null
			: "群成员必须包含提问的人";
	}
	if (!(key in LOW_RISK)) return "这个接口不能替别人调用";
	const schema =
		key === "POST /api/conversations/:id/topics"
			? CreateTopicRequestSchema
			: AddMemberRequestSchema;
	if (!schema.safeParse(body).success) return "请求体不合法";
	const conversationId = params.id ?? "";
	if (!isUuid(conversationId)) return "会话不存在";
	const conversation = await scope.s.first(
		conversations,
		eq(conversations.id, conversationId),
	);
	if (!conversation) return "会话不存在";
	if (!(await memberPrincipals(scope.s, conversationId)).has(requesterId))
		return "提问的人不在这个会话里";
	if (
		key === "POST /api/conversations/:id/members" &&
		conversation.kind !== "group"
	)
		return "只能把人加进群聊";
	return null;
}

function clip(text: string): string {
	const chars = Array.from(text);
	if (chars.length <= RESPONSE_LIMIT) return text;
	return `${chars.slice(0, RESPONSE_LIMIT).join("")}\n（响应体共 ${chars.length} 字，已截断到前 ${RESPONSE_LIMIT} 字）`;
}

/** 错误响应里的说明（统一错误体 `{ error: { message } }`），取不到时为空。 */
function errorMessage(text: string): string {
	try {
		const parsed = JSON.parse(text) as { error?: { message?: unknown } };
		const message = parsed.error?.message;
		return typeof message === "string" ? message : "";
	} catch {
		return "";
	}
}

async function callApp(
	scope: ToolScope,
	method: ApiMethod,
	url: URL,
	body: unknown,
): Promise<Response> {
	const { app } = await import("@/index");
	const hasBody = body !== undefined && method !== "GET";
	return app.request(
		`${url.pathname}${url.search}`,
		{
			method,
			headers: hasBody ? { "content-type": "application/json" } : {},
			body: hasBody ? JSON.stringify(body) : undefined,
		},
		await internalCallEnv(scope.agent.principal.id, scope.owner),
	);
}

export const appApiCallTool = makeTool({
	name: "app_api_call",
	description:
		"以本人的身份调用 orgos 的一个接口（先用 app_api_search 找到接口与入参）。返回状态码与响应体（过长时截断）。不许编造接口或参数；需要的 id 先用查询类接口查到。",
	label: "正在操作…",
	schema: CallSchema,
	available: appApiAvailable,
	run: async (args, scope) => {
		const { method } = args;
		const url = resolveUrl(args);
		const shown = `${method} ${url?.pathname ?? args.path}`;
		if (!url)
			return refuse(
				"路径不合法：用 / 开头的接口路径，不带编码字符",
				`调用接口 ${shown}：路径不合法`,
			);
		const match = matchEntry(method, url.pathname);
		if (!match || match.entry.risk === "excluded")
			return refuse(
				`无权限：${shown} 不开放给代理（${match?.entry.purpose ?? "未登记的接口"}）`,
				`调用接口 ${shown}：不开放给代理`,
			);
		if (scope.actingFor.kind === "other") {
			const reason = await otherLimit(
				scope,
				scope.actingFor.principalId,
				match,
				args.body,
			);
			if (reason)
				return refuse(
					`无权限：替别人办事时${reason}，调用 escalate_to_owner 交给本人决定。替别人只能查公开信息，或：${Object.values(LOW_RISK).join("；")}。`,
					`调用接口 ${shown}：无权限（${reason}）`,
				);
		}
		const log = { runId: scope.runId };
		await appendTaskLog(scope.s, log, "tool_call", {
			title: shown,
			kind: "app_api",
			input: { query: args.query, body: args.body },
		});
		const res = await callApp(scope, method, url, args.body);
		const text = await res.text();
		const output = clip(text);
		await appendTaskLog(scope.s, log, "tool_result", {
			title: shown,
			ok: res.ok,
			output,
		});
		const detail = res.ok ? "" : ` ${errorMessage(text)}`.trimEnd();
		return {
			result: `HTTP ${res.status}\n${output || "（无响应体）"}`,
			summary: `调用接口 ${shown}：${res.status}${detail ? ` ${detail}` : ""}`,
			ok: res.ok,
		};
	},
});
