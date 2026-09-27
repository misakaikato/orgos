/**
 * 模型调用记账（`llm_requests`）：每次调用结束（成功、失败、中止）写一行；按代理汇总用量。
 */
import type { AgentUsage } from "@orgos/protocol";
import { count, eq, inArray, sql } from "drizzle-orm";
import { llmRequests, principals } from "@/db/schema";
import { type Scoped, scoped } from "@/db/scope";

export type LlmRequestRow = Omit<
	typeof llmRequests.$inferInsert,
	"id" | "createdAt"
>;

export type RecordLlmRequest = (row: LlmRequestRow) => Promise<void>;

export const recordLlmRequest: RecordLlmRequest = async (row) => {
	const { tenantId, ...values } = row;
	await scoped(tenantId).insert(llmRequests, values);
};

/**
 * 写账：失败只记日志，绝不影响回复。
 */
export async function recordSafely(
	record: RecordLlmRequest,
	row: LlmRequestRow,
): Promise<void> {
	try {
		await record(row);
	} catch (e) {
		console.error("[llm_requests] 写账失败", e);
	}
}

/** 某人的全部代理（含已删除的）各自的用量；没有调用过的代理不出现。 */
export async function usageByAgent(
	s: Scoped,
	ownerId: string,
): Promise<AgentUsage[]> {
	const owned = await s.select(
		principals,
		eq(principals.ownerId, ownerId),
		eq(principals.kind, "agent"),
	);
	if (owned.length === 0) return [];
	const rows = await s.executor
		.select({
			agentId: llmRequests.agentId,
			requests: count(),
			inputTokens: sql<string>`coalesce(sum(${llmRequests.inputTokens}), 0)`,
			outputTokens: sql<string>`coalesce(sum(${llmRequests.outputTokens}), 0)`,
			costMicroUsd: sql<string>`coalesce(sum(${llmRequests.costMicroUsd}), 0)`,
		})
		.from(llmRequests)
		.where(
			s.where(
				llmRequests,
				inArray(
					llmRequests.agentId,
					owned.map((p) => p.id),
				),
			),
		)
		.groupBy(llmRequests.agentId);
	return rows.map((r) => ({
		agentId: r.agentId,
		requests: r.requests,
		inputTokens: Number(r.inputTokens),
		outputTokens: Number(r.outputTokens),
		costMicroUsd: Number(r.costMicroUsd),
	}));
}
