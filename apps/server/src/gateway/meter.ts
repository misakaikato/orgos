/**
 * 计量：网关的每次上游尝试写一行 llm_requests（成功、失败、中止都写；写账失败只记日志，不影响响应）。
 * 成本按预设厂商表的单价：costMicroUsd = round(Σ tokens × 单价)，单价单位是"美元 / 百万 token"，
 * 乘出来恰为微美元。未定价的模型或用量解析失败 → 成本为空。
 */
import {
	type GatewayProtocol,
	type PresetModel,
	presetModel,
} from "@orgos/protocol";
import type { IrUsage } from "@/gateway/ir";
import { recordLlmRequest, recordSafely } from "@/services/llm-requests";

/** 被调用方中止时记的状态码（nginx 的 499 client closed request）。 */
export const STATUS_ABORTED = 499;
/** 连不上上游时记的状态码。 */
export const STATUS_NO_RESPONSE = 0;

/** 这次调用算在谁头上。 */
export type Attribution = {
	tenantId: string;
	/** 系统运行（记忆提炼、画像整理）为空。 */
	agentId: string | null;
	onBehalfOfId: string | null;
	conversationId: string | null;
	runId: string | null;
	taskId: string | null;
};

export function costMicroUsd(
	usage: IrUsage,
	pricing: PresetModel | undefined,
	parseError: boolean,
): number | null {
	if (!pricing || parseError) return null;
	const priced = [
		pricing.inputPerMtok,
		pricing.outputPerMtok,
		pricing.cacheReadPerMtok,
		pricing.cacheWritePerMtok,
	].some((p) => p !== undefined);
	if (!priced) return null;
	const term = (tok: number | null, price?: number) =>
		tok !== null && price !== undefined ? tok * price : 0;
	return Math.round(
		term(usage.inputTokens, pricing.inputPerMtok) +
			term(usage.outputTokens, pricing.outputPerMtok) +
			term(usage.cacheReadTokens, pricing.cacheReadPerMtok) +
			term(usage.cacheWriteTokens, pricing.cacheWritePerMtok),
	);
}

export type Attempt = {
	provider: string;
	preset: string | null;
	model: string;
	protocolIn: GatewayProtocol;
	protocolOut: GatewayProtocol;
	groupId: string | null;
	usage: IrUsage;
	parseError: boolean;
	httpStatus: number;
	durationMs: number;
};

export async function recordAttempt(
	who: Attribution,
	a: Attempt,
): Promise<void> {
	await recordSafely(recordLlmRequest, {
		tenantId: who.tenantId,
		agentId: who.agentId,
		onBehalfOfId: who.onBehalfOfId,
		conversationId: who.conversationId,
		runId: who.runId,
		taskId: who.taskId,
		provider: a.provider,
		model: a.model,
		protocolIn: a.protocolIn,
		protocolOut: a.protocolOut,
		groupId: a.groupId,
		inputTokens: a.usage.inputTokens,
		outputTokens: a.usage.outputTokens,
		cacheReadTokens: a.usage.cacheReadTokens,
		costMicroUsd: costMicroUsd(
			a.usage,
			presetModel(a.preset, a.model),
			a.parseError,
		),
		durationMs: a.durationMs,
		httpStatus: a.httpStatus,
		parseError: a.parseError,
	});
}
