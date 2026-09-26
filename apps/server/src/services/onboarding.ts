import type { OnboardingRequest, OnboardingResponse } from "@orgos/protocol";
import { ERROR_CODES } from "@orgos/protocol";
import { db } from "@/db";
import { members, principals } from "@/db/schema";
import {
	createTenant,
	findMembership,
	findTenantByInviteCode,
	scoped,
} from "@/db/scope";
import { AppError, PG_UNIQUE_VIOLATION, pgErrorOf } from "@/lib/errors";
import { toPrincipal, toTenant } from "@/lib/serialize";
import { createAgent } from "@/services/agents";

const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_LENGTH = 10;

export function newInviteCode(): string {
	const bytes = crypto.getRandomValues(new Uint32Array(INVITE_LENGTH));
	return Array.from(
		bytes,
		(b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length],
	).join("");
}

export function normalizeInviteCode(code: string): string {
	return code.trim().toUpperCase();
}

/**
 * 注册后的入驻：一个事务内建（或加入）租户、成员、本人主体与两个代理（幕僚长、执行助理）。
 * 已有成员身份 → 409 ALREADY_ONBOARDED；handle 冲突 → 409 HANDLE_TAKEN；邀请码无效 → 400。
 */
export async function onboard(
	userId: string,
	req: OnboardingRequest,
): Promise<OnboardingResponse> {
	if (await findMembership(userId)) {
		throw new AppError(409, ERROR_CODES.ALREADY_ONBOARDED, "该账号已加入组织");
	}
	try {
		return await db.transaction(async (tx) => {
			const isOwner = req.mode === "create";
			const tenant =
				req.mode === "create"
					? await createTenant(
							{ name: req.orgName, inviteCode: newInviteCode() },
							tx,
						)
					: await findTenantByInviteCode(
							normalizeInviteCode(req.inviteCode),
							tx,
						);
			if (!tenant) {
				throw new AppError(400, ERROR_CODES.INVITE_CODE_INVALID, "邀请码无效");
			}
			const s = scoped(tenant.id, tx);
			await s.insert(members, { userId, role: isOwner ? "owner" : "member" });
			const human = await s.insert(principals, {
				kind: "human",
				userId,
				ownerId: null,
				handle: req.handle,
				displayName: req.displayName,
			});
			const chief = await createAgent(s, {
				ownerId: human.id,
				role: "front",
				handle: `${req.handle}-chief`,
				displayName: `${req.displayName}的幕僚长`,
				description: `代表${req.displayName}对外沟通：回答同事的问题，把具体事务分派给组内专员，超出授权的事转给${req.displayName}本人。`,
			});
			const ops = await createAgent(s, {
				ownerId: human.id,
				role: "specialist",
				handle: `${req.handle}-ops`,
				displayName: `${req.displayName}的执行助理`,
				description: `执行${req.displayName}交办的具体事务；绑定设备后可在${req.displayName}的电脑上读写文件、执行命令。`,
			});
			return {
				tenant: toTenant(tenant, isOwner),
				principal: toPrincipal(human),
				agents: [chief, ops],
			};
		});
	} catch (e) {
		const pg = pgErrorOf(e);
		if (pg?.code === PG_UNIQUE_VIOLATION) {
			if (pg.constraint_name === "principals_tenant_handle_unique") {
				throw new AppError(409, ERROR_CODES.HANDLE_TAKEN, "handle 已被占用");
			}
			if (pg.constraint_name === "members_user_id_unique") {
				throw new AppError(
					409,
					ERROR_CODES.ALREADY_ONBOARDED,
					"该账号已加入组织",
				);
			}
		}
		throw e;
	}
}
