/**
 * 租户设置：每租户至多一行，没有行即全部取默认值。只有租户 owner 能改。
 */
import type {
	TenantSettings,
	UpdateTenantSettingsRequest,
} from "@orgos/protocol";
import { ERROR_CODES } from "@orgos/protocol";
import { tenantSettings } from "@/db/schema";
import type { Member, Scoped } from "@/db/scope";
import { AppError } from "@/lib/errors";

export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
	allowUnsupervisedAdapters: false,
};

export async function getTenantSettings(s: Scoped): Promise<TenantSettings> {
	const row = await s.first(tenantSettings);
	return row
		? { allowUnsupervisedAdapters: row.allowUnsupervisedAdapters }
		: DEFAULT_TENANT_SETTINGS;
}

export async function updateTenantSettings(
	s: Scoped,
	member: Member,
	patch: UpdateTenantSettingsRequest,
): Promise<TenantSettings> {
	if (member.role !== "owner")
		throw new AppError(403, ERROR_CODES.FORBIDDEN, "只有组织的创建者能改设置");
	const next = { ...(await getTenantSettings(s)), ...patch };
	await s.executor
		.insert(tenantSettings)
		.values({ tenantId: s.tenantId, ...next })
		.onConflictDoUpdate({ target: tenantSettings.tenantId, set: next });
	return next;
}
