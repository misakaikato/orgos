/**
 * 租户设置：每租户至多一行，没有行即全部取默认值。只有租户 owner 能改。
 *
 * - 默认模型须是本租户可用的模型引用；
 * - 外部助手的个人模式只有在"允许个人模式"打开时才能选；关掉允许时模式回到企业模式。
 */
import {
	DEFAULT_AGENT_MODEL,
	ERROR_CODES,
	type TenantSettings,
	type UpdateTenantSettingsRequest,
} from "@orgos/protocol";
import { tenantSettings } from "@/db/schema";
import type { Member, Scoped } from "@/db/scope";
import { AppError, badRequest } from "@/lib/errors";
import { requireAvailableModel } from "@/services/model-providers";

export type FullTenantSettings = Required<TenantSettings>;

export const DEFAULT_TENANT_SETTINGS: FullTenantSettings = {
	allowUnsupervisedAdapters: false,
	defaultModel: DEFAULT_AGENT_MODEL,
	externalAgentMode: "enterprise",
	allowPersonalExternal: false,
};

export async function getTenantSettings(
	s: Scoped,
): Promise<FullTenantSettings> {
	const row = await s.first(tenantSettings);
	return row
		? {
				allowUnsupervisedAdapters: row.allowUnsupervisedAdapters,
				defaultModel: row.defaultModel,
				externalAgentMode: row.externalAgentMode,
				allowPersonalExternal: row.allowPersonalExternal,
			}
		: DEFAULT_TENANT_SETTINGS;
}

export async function updateTenantSettings(
	s: Scoped,
	member: Member,
	patch: UpdateTenantSettingsRequest,
): Promise<FullTenantSettings> {
	if (member.role !== "owner")
		throw new AppError(403, ERROR_CODES.FORBIDDEN, "只有组织的创建者能改设置");
	const next = { ...(await getTenantSettings(s)), ...patch };
	if (patch.defaultModel !== undefined)
		await requireAvailableModel(s, patch.defaultModel);
	if (patch.externalAgentMode === "personal" && !next.allowPersonalExternal)
		throw badRequest("组织还没有允许外部助手使用个人模式");
	if (!next.allowPersonalExternal) next.externalAgentMode = "enterprise";
	await s.executor
		.insert(tenantSettings)
		.values({ tenantId: s.tenantId, ...next })
		.onConflictDoUpdate({ target: tenantSettings.tenantId, set: next });
	return next;
}
