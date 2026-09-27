/**
 * 任务令牌：外部 agent 在企业模式下调用网关的唯一凭据。
 *
 * - 为一个话题的外部会话签发（随 acp_start 下发给 Runner，只在本次子进程的环境变量里），
 *   绑定租户、外部助手与其本人、该话题的外部会话；库里只存 SHA-256；
 * - 外部会话关闭（话题归档、助手删除、设备吊销、闲置收掉、agent 进程退出）时吊销；
 * - 话题里任务的开始与结束不影响令牌；调用记在请求发生时话题当前的任务名下（见 routes/llm）。
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { gatewayTokens } from "@/db/schema";
import {
	findActiveGatewayToken,
	type GatewayTokenRow,
	type Scoped,
} from "@/db/scope";

const TOKEN_PREFIX = "ogt_";

function hashOf(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export type TokenBinding = {
	agentId: string;
	onBehalfOfId: string;
	conversationId: string;
	topicId: string;
	runnerId: string;
};

export async function issueGatewayToken(
	s: Scoped,
	binding: TokenBinding,
): Promise<string> {
	const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
	await s.insert(gatewayTokens, { tokenHash: hashOf(token), ...binding });
	return token;
}

/** 吊销某话题外部会话的全部令牌。 */
export async function revokeTopicTokens(
	s: Scoped,
	topicId: string,
): Promise<void> {
	await s.executor
		.update(gatewayTokens)
		.set({ revokedAt: new Date() })
		.where(
			s.where(
				gatewayTokens,
				and(
					eq(gatewayTokens.topicId, topicId),
					isNull(gatewayTokens.revokedAt),
				),
			),
		);
}

/** 校验令牌：未吊销 → 令牌记录；否则 null。 */
export async function verifyGatewayToken(
	token: string,
): Promise<GatewayTokenRow | null> {
	if (!token.startsWith(TOKEN_PREFIX)) return null;
	return (await findActiveGatewayToken(hashOf(token))) ?? null;
}
