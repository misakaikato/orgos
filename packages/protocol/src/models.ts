/**
 * 企业模型网关的共享契约：三种接口协议、预设厂商表（唯一定义处）、模型引用的写法、
 * 厂商与路由组的线上形态。服务端、前端共用这一处。
 *
 * 端点约定（与各家官方 SDK 的 base URL 一致）：
 *   openai    → `${base}/chat/completions`、`${base}/models`
 *   responses → `${base}/responses`
 *   anthropic → `${base}/v1/messages`、`${base}/v1/models`
 */
import { z } from "zod";

export const GATEWAY_PROTOCOLS = ["openai", "anthropic", "responses"] as const;
export type GatewayProtocol = (typeof GATEWAY_PROTOCOLS)[number];

export const GATEWAY_PROTOCOL_LABEL: Record<GatewayProtocol, string> = {
	openai: "OpenAI Chat Completions",
	anthropic: "Anthropic Messages",
	responses: "OpenAI Responses",
};

export const ProviderEndpointsSchema = z.object({
	openai: z.url().max(500).optional(),
	anthropic: z.url().max(500).optional(),
	responses: z.url().max(500).optional(),
});
export type ProviderEndpoints = z.infer<typeof ProviderEndpointsSchema>;

/** 单价单位：美元 / 百万 token。未列出的模型不计价（costMicroUsd 为空）。 */
export type PresetModel = {
	id: string;
	inputPerMtok?: number;
	outputPerMtok?: number;
	cacheReadPerMtok?: number;
	cacheWritePerMtok?: number;
	contextWindow?: number;
};

export type ProviderPreset = {
	id: string;
	label: string;
	endpoints: ProviderEndpoints;
	/** 本地推理服务不校验 key。 */
	needsKey: boolean;
	/** anthropic 端点的鉴权头：官方只认 x-api-key；各家兼容端点同时接受 Bearer。 */
	anthropicAuth: "x-api-key" | "both";
	/** 代理引擎经 openai 协议调用时关闭思考所需的请求体字段（不关时思考会吃光 max_tokens）。 */
	openaiThinkingOff?: Record<string, unknown>;
	models: readonly PresetModel[];
	/** 端点依据（官方文档）。 */
	source: string;
};

/**
 * 预设厂商。只写官方文档里确认过的端点；不确定的协议不写（网关会改用其他协议并做翻译）。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
	{
		id: "deepseek",
		label: "DeepSeek",
		endpoints: {
			openai: "https://api.deepseek.com/v1",
			anthropic: "https://api.deepseek.com/anthropic",
		},
		needsKey: true,
		anthropicAuth: "both",
		openaiThinkingOff: { thinking: { type: "disabled" } },
		models: [
			{
				id: "deepseek-v4-flash",
				inputPerMtok: 0.139,
				outputPerMtok: 0.278,
				cacheReadPerMtok: 0.0028,
				contextWindow: 128_000,
			},
			{
				id: "deepseek-v4-pro",
				inputPerMtok: 0.417,
				outputPerMtok: 0.833,
				cacheReadPerMtok: 0.0035,
				contextWindow: 128_000,
			},
		],
		source: "https://api-docs.deepseek.com/guides/anthropic_api",
	},
	{
		id: "anthropic",
		label: "Anthropic",
		endpoints: {
			anthropic: "https://api.anthropic.com",
			openai: "https://api.anthropic.com/v1",
		},
		needsKey: true,
		anthropicAuth: "x-api-key",
		models: [],
		source: "https://platform.claude.com/docs/en/api/openai-sdk",
	},
	{
		id: "openai",
		label: "OpenAI",
		endpoints: {
			openai: "https://api.openai.com/v1",
			responses: "https://api.openai.com/v1",
		},
		needsKey: true,
		anthropicAuth: "both",
		models: [],
		source: "https://platform.openai.com/docs/api-reference/responses",
	},
	{
		id: "moonshot",
		label: "Moonshot / Kimi",
		endpoints: {
			openai: "https://api.moonshot.ai/v1",
			responses: "https://api.moonshot.ai/v1",
			anthropic: "https://api.moonshot.ai/anthropic",
		},
		needsKey: true,
		anthropicAuth: "both",
		models: [],
		source: "https://platform.kimi.ai/docs/api/overview",
	},
	{
		id: "zhipu",
		label: "智谱 GLM",
		endpoints: {
			openai: "https://open.bigmodel.cn/api/paas/v4",
			anthropic: "https://open.bigmodel.cn/api/anthropic",
		},
		needsKey: true,
		anthropicAuth: "both",
		models: [],
		source: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
	},
	{
		id: "qwen",
		label: "阿里 Qwen（百炼）",
		endpoints: {
			openai: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			anthropic: "https://dashscope.aliyuncs.com/apps/anthropic",
		},
		needsKey: true,
		anthropicAuth: "both",
		models: [],
		source: "https://help.aliyun.com/zh/model-studio/claude-code",
	},
	{
		id: "minimax",
		label: "MiniMax",
		endpoints: {
			openai: "https://api.minimaxi.com/v1",
			anthropic: "https://api.minimaxi.com/anthropic",
		},
		needsKey: true,
		anthropicAuth: "both",
		models: [],
		source: "https://platform.minimax.io/docs/guides/text-ai-coding-tools",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		endpoints: {
			openai: "https://openrouter.ai/api/v1",
			responses: "https://openrouter.ai/api/v1",
			anthropic: "https://openrouter.ai/api",
		},
		needsKey: true,
		anthropicAuth: "both",
		models: [],
		source:
			"https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration",
	},
	{
		id: "ollama",
		label: "Ollama（本机）",
		endpoints: {
			openai: "http://localhost:11434/v1",
			responses: "http://localhost:11434/v1",
			anthropic: "http://localhost:11434",
		},
		needsKey: false,
		anthropicAuth: "both",
		models: [],
		source: "https://docs.ollama.com/api/openai-compatibility",
	},
	{
		id: "lmstudio",
		label: "LM Studio（本机）",
		endpoints: {
			openai: "http://localhost:1234/v1",
			responses: "http://localhost:1234/v1",
			anthropic: "http://localhost:1234",
		},
		needsKey: false,
		anthropicAuth: "both",
		models: [],
		source: "https://lmstudio.ai/docs/developer/anthropic-compat",
	},
];

export function findPreset(id: string | null | undefined) {
	return id ? PROVIDER_PRESETS.find((p) => p.id === id) : undefined;
}

export function presetModel(
	presetId: string | null | undefined,
	modelId: string,
): PresetModel | undefined {
	return findPreset(presetId)?.models.find((m) => m.id === modelId);
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 模型的上下文窗口：预设表里有记载的取记载值，否则取默认。 */
export function contextWindowOf(modelRef: string): number {
	const ref = parseModelRef(modelRef);
	if (ref?.kind !== "model") return DEFAULT_CONTEXT_WINDOW;
	for (const p of PROVIDER_PRESETS) {
		const m = p.models.find((x) => x.id === ref.model);
		if (m?.contextWindow) return m.contextWindow;
	}
	return DEFAULT_CONTEXT_WINDOW;
}

// ─────────────────────────── 模型引用 ───────────────────────────

/** 模型引用只有两种写法：`<厂商名>/<模型 id>` 或 `group/<路由组 id>`。 */
export const GROUP_REF_PREFIX = "group/";

/** 厂商名：用在模型引用里，建好后不能改。`group` 保留给路由组。 */
export const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const ProviderNameSchema = z
	.string()
	.regex(PROVIDER_NAME_RE, "厂商名只能用小写字母、数字、- 与 _")
	.refine((n) => n !== "group", "group 是保留名");

export type ModelRef =
	| { kind: "group"; groupId: string }
	| { kind: "model"; provider: string; model: string };

/** 解析模型引用：厂商名在第一个斜杠前，其余都是模型 id（模型 id 自己可以带斜杠）。 */
export function parseModelRef(ref: string): ModelRef | null {
	const at = ref.indexOf("/");
	if (at <= 0 || at === ref.length - 1) return null;
	const head = ref.slice(0, at);
	const rest = ref.slice(at + 1);
	if (head === "group") return { kind: "group", groupId: rest };
	if (!PROVIDER_NAME_RE.test(head)) return null;
	return { kind: "model", provider: head, model: rest };
}

export function modelRefOf(provider: string, model: string): string {
	return `${provider}/${model}`;
}

export function groupRefOf(groupId: string): string {
	return `${GROUP_REF_PREFIX}${groupId}`;
}

export const ModelRefSchema = z
	.string()
	.min(3)
	.max(300)
	.refine(
		(r) => parseModelRef(r) !== null,
		"模型须写成 厂商/模型 或 group/<id>",
	);

// ─────────────────────────── 实体 ───────────────────────────

export const GROUP_ROUTINGS = ["order", "rotate"] as const;
export type GroupRouting = (typeof GROUP_ROUTINGS)[number];

export const GROUP_ROUTING_LABEL: Record<GroupRouting, string> = {
	order: "依次尝试",
	rotate: "轮换",
};

/** 厂商的线上形态：key 只写不读，这里只说有没有配。 */
export const ModelProviderSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	preset: z.string().nullable(),
	endpoints: ProviderEndpointsSchema,
	exposedModels: z.array(z.string()),
	hasKey: z.boolean(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ModelGroupSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	members: z.array(z.string()),
	routing: z.enum(GROUP_ROUTINGS),
	createdAt: z.iso.datetime(),
});
export type ModelGroup = z.infer<typeof ModelGroupSchema>;

export const EXTERNAL_AGENT_MODES = ["enterprise", "personal"] as const;
export type ExternalAgentMode = (typeof EXTERNAL_AGENT_MODES)[number];

export const EXTERNAL_AGENT_MODE_LABEL: Record<ExternalAgentMode, string> = {
	enterprise: "企业模式",
	personal: "个人模式",
};

/** 外部助手实际用的模式：个人模式只在组织允许时生效。 */
export function effectiveExternalMode(settings: {
	externalAgentMode: ExternalAgentMode;
	allowPersonalExternal: boolean;
}): ExternalAgentMode {
	return settings.externalAgentMode === "personal" &&
		settings.allowPersonalExternal
		? "personal"
		: "enterprise";
}

// ─────────────────────────── 网关地址 ───────────────────────────

/** 网关挂在服务端的这个路径下：`/llm/v1/chat/completions`、`/llm/v1/responses`、`/llm/v1/messages`、`/llm/v1/models`。 */
export const GATEWAY_PATH = "/llm";

/** 由服务端地址得到网关地址（外部 agent 的 base URL）。 */
export function gatewayBaseUrl(server: string): string {
	return `${new URL(server).origin}${GATEWAY_PATH}`;
}
