/**
 * 模型供应商与单价配置（`llm-providers.json`）。阶段一只接 DeepSeek，结构保留多供应商形态。
 *
 * - 首次访问时读取并 Zod 校验，校验失败直接抛错（启动期快速失败）。
 * - 单价字段可省略：pricingFor 返回 null → 该请求 costMicroUsd 为 null（未定价）。
 * - 单价单位是"美元 / 百万 token"。
 */
import { z } from "zod";
import raw from "@/agent/llm-providers.json";

const ModelSchema = z.object({
	id: z.string().min(1),
	inputPerMtok: z.number().nonnegative().optional(),
	outputPerMtok: z.number().nonnegative().optional(),
	cacheReadPerMtok: z.number().nonnegative().optional(),
	cacheWritePerMtok: z.number().nonnegative().optional(),
	/** 上下文窗口（token）；缺省按 DEFAULT_CONTEXT_WINDOW。 */
	contextWindow: z.number().int().positive().optional(),
});

const ProviderSchema = z.object({
	id: z.string().min(1),
	protocol: z.literal("openai"),
	baseUrl: z.url(),
	apiKeyEnv: z.string().min(1),
	models: z.array(ModelSchema).min(1),
});

const ProvidersConfigSchema = z.object({
	providers: z.array(ProviderSchema).min(1),
	default: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
});

export type ModelPricing = {
	inputPerMtok?: number;
	outputPerMtok?: number;
	cacheReadPerMtok?: number;
	cacheWritePerMtok?: number;
};

export type ProviderConfig = z.infer<typeof ProviderSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

let cached: ProvidersConfig | null = null;

export function loadProviderConfig(): ProvidersConfig {
	cached ??= ProvidersConfigSchema.parse(raw);
	return cached;
}

/** 默认供应商（阶段一即 DeepSeek）。 */
export function defaultProvider(): ProviderConfig {
	const config = loadProviderConfig();
	const provider = config.providers.find(
		(p) => p.id === config.default.provider,
	);
	if (!provider)
		throw new Error(`默认供应商 ${config.default.provider} 未配置`);
	return provider;
}

/** 某供应商下某模型的单价；模型不在配置中或无任何单价字段 → null。 */
export function pricingFor(
	provider: ProviderConfig,
	modelId: string,
): ModelPricing | null {
	const m = provider.models.find((x) => x.id === modelId);
	if (!m) return null;
	const { id: _, contextWindow: __, ...pricing } = m;
	return Object.values(pricing).some((v) => v !== undefined) ? pricing : null;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 默认供应商下某模型的上下文窗口（token）。 */
export function contextWindowFor(modelId: string): number {
	return (
		defaultProvider().models.find((m) => m.id === modelId)?.contextWindow ??
		DEFAULT_CONTEXT_WINDOW
	);
}
