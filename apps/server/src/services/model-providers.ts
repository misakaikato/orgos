/**
 * 模型厂商与路由组：本租户所有模型调用的上游清单。只有租户 owner 能管理；key 只写不读。
 *
 * - 模型引用 `厂商名/模型` 只在该模型被勾选开放时可用；`group/<id>` 可用当且仅当组里至少有一个可用成员；
 * - 解析引用得到一串上游（路由组 order 按顺序、rotate 每次从下一个成员起），网关依次尝试。
 */
import {
	type CreateModelGroupRequest,
	type CreateModelProviderRequest,
	ERROR_CODES,
	findPreset,
	type GroupRouting,
	groupRefOf,
	type ModelGroup,
	type ModelOption,
	type ModelProvider,
	modelRefOf,
	parseModelRef,
	type UpdateModelGroupRequest,
	type UpdateModelProviderRequest,
} from "@orgos/protocol";
import { asc, eq } from "drizzle-orm";
import { modelGroups, modelProviders } from "@/db/schema";
import type { Member, Scoped } from "@/db/scope";
import { decryptSecret, encryptSecret } from "@/gateway/secret";
import type { Upstream } from "@/gateway/upstream";
import {
	AppError,
	badRequest,
	notFound,
	PG_UNIQUE_VIOLATION,
	pgErrorOf,
} from "@/lib/errors";
import { isUuid } from "@/lib/uuid";

type ProviderRow = typeof modelProviders.$inferSelect;
type GroupRow = typeof modelGroups.$inferSelect;

export function requireTenantOwner(member: Member): void {
	if (member.role !== "owner")
		throw new AppError(
			403,
			ERROR_CODES.FORBIDDEN,
			"只有组织的创建者能管理模型",
		);
}

export function toModelProvider(row: ProviderRow): ModelProvider {
	return {
		id: row.id,
		name: row.name,
		preset: row.preset,
		endpoints: row.endpoints,
		exposedModels: row.exposedModels,
		hasKey: row.keyCiphertext !== null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export function toModelGroup(row: GroupRow): ModelGroup {
	return {
		id: row.id,
		name: row.name,
		members: row.members,
		routing: row.routing,
		createdAt: row.createdAt.toISOString(),
	};
}

export async function listProviders(s: Scoped): Promise<ProviderRow[]> {
	return s.executor
		.select()
		.from(modelProviders)
		.where(s.where(modelProviders))
		.orderBy(asc(modelProviders.createdAt));
}

export async function listGroups(s: Scoped): Promise<GroupRow[]> {
	return s.executor
		.select()
		.from(modelGroups)
		.where(s.where(modelGroups))
		.orderBy(asc(modelGroups.createdAt));
}

export async function requireProvider(
	s: Scoped,
	id: string,
): Promise<ProviderRow> {
	const row = isUuid(id)
		? await s.first(modelProviders, eq(modelProviders.id, id))
		: undefined;
	if (!row) throw notFound("厂商不存在");
	return row;
}

function sealKey(apiKey: string | undefined): string | null | undefined {
	if (apiKey === undefined) return undefined;
	return apiKey ? encryptSecret(apiKey) : null;
}

function uniqueModels(models: readonly string[]): string[] {
	return [...new Set(models.map((m) => m.trim()).filter(Boolean))];
}

export async function createProvider(
	s: Scoped,
	req: CreateModelProviderRequest,
): Promise<ProviderRow> {
	if (req.preset && !findPreset(req.preset))
		throw badRequest(`没有叫 ${req.preset} 的预设厂商`);
	if (!Object.values(req.endpoints).some(Boolean))
		throw badRequest("至少要填一个端点");
	try {
		return await s.insert(modelProviders, {
			name: req.name,
			preset: req.preset ?? null,
			endpoints: req.endpoints,
			keyCiphertext: sealKey(req.apiKey) ?? null,
			exposedModels: uniqueModels(req.exposedModels ?? []),
		});
	} catch (e) {
		if (pgErrorOf(e)?.code === PG_UNIQUE_VIOLATION)
			throw new AppError(409, ERROR_CODES.NAME_TAKEN, "已有同名厂商");
		throw e;
	}
}

export async function updateProvider(
	s: Scoped,
	id: string,
	req: UpdateModelProviderRequest,
): Promise<ProviderRow> {
	await requireProvider(s, id);
	if (req.endpoints && !Object.values(req.endpoints).some(Boolean))
		throw badRequest("至少要填一个端点");
	const key = sealKey(req.apiKey);
	const [row] = await s.executor
		.update(modelProviders)
		.set({
			...(req.endpoints ? { endpoints: req.endpoints } : {}),
			...(key !== undefined ? { keyCiphertext: key } : {}),
			...(req.exposedModels
				? { exposedModels: uniqueModels(req.exposedModels) }
				: {}),
		})
		.where(s.where(modelProviders, eq(modelProviders.id, id)))
		.returning();
	if (!row) throw notFound("厂商不存在");
	return row;
}

export async function deleteProvider(s: Scoped, id: string): Promise<void> {
	await requireProvider(s, id);
	await s.executor
		.delete(modelProviders)
		.where(s.where(modelProviders, eq(modelProviders.id, id)));
}

/** 厂商 → 上游（解开 key）。 */
export function upstreamOf(row: ProviderRow): Upstream {
	return {
		providerId: row.id,
		provider: row.name,
		preset: findPreset(row.preset),
		endpoints: row.endpoints,
		apiKey: row.keyCiphertext ? decryptSecret(row.keyCiphertext) : null,
	};
}

// ─────────────────────────── 路由组 ───────────────────────────

export async function requireGroup(s: Scoped, id: string): Promise<GroupRow> {
	const row = isUuid(id)
		? await s.first(modelGroups, eq(modelGroups.id, id))
		: undefined;
	if (!row) throw notFound("路由组不存在");
	return row;
}

function assertMembersAreModels(members: readonly string[]): void {
	for (const m of members)
		if (parseModelRef(m)?.kind !== "model")
			throw badRequest(`路由组成员须写成 厂商/模型：${m}`);
}

export async function createGroup(
	s: Scoped,
	req: CreateModelGroupRequest,
): Promise<GroupRow> {
	assertMembersAreModels(req.members);
	return s.insert(modelGroups, {
		name: req.name,
		members: req.members,
		routing: req.routing,
	});
}

export async function updateGroup(
	s: Scoped,
	id: string,
	req: UpdateModelGroupRequest,
): Promise<GroupRow> {
	await requireGroup(s, id);
	if (req.members) assertMembersAreModels(req.members);
	const [row] = await s.executor
		.update(modelGroups)
		.set(req)
		.where(s.where(modelGroups, eq(modelGroups.id, id)))
		.returning();
	if (!row) throw notFound("路由组不存在");
	return row;
}

export async function deleteGroup(s: Scoped, id: string): Promise<void> {
	await requireGroup(s, id);
	await s.executor
		.delete(modelGroups)
		.where(s.where(modelGroups, eq(modelGroups.id, id)));
}

// ─────────────────────────── 可选模型与解析 ───────────────────────────

/** 本租户开放的模型与路由组（代理选模型用）。 */
export async function modelOptions(s: Scoped): Promise<ModelOption[]> {
	const providers = await listProviders(s);
	const options: ModelOption[] = providers.flatMap((p) =>
		p.exposedModels.map((m) => ({
			ref: modelRefOf(p.name, m),
			label: `${p.name} / ${m}`,
			kind: "model" as const,
		})),
	);
	for (const g of await listGroups(s))
		options.push({
			ref: groupRefOf(g.id),
			label: `路由组：${g.name}`,
			kind: "group",
		});
	return options;
}

export type UpstreamTarget = Upstream & { model: string };

export type Resolved =
	| { ok: true; targets: UpstreamTarget[]; groupId: string | null }
	| { ok: false; message: string };

const rotation = new Map<string, number>();

function rotate<T>(groupId: string, list: T[]): T[] {
	const n = rotation.get(groupId) ?? 0;
	rotation.set(groupId, n + 1);
	const at = n % list.length;
	return [...list.slice(at), ...list.slice(0, at)];
}

/** 解析模型引用为按尝试顺序排列的上游；不可用 → 原因。advance=false 只查不轮换。 */
export async function resolveModel(
	s: Scoped,
	ref: string,
	advance = true,
): Promise<Resolved> {
	const parsed = parseModelRef(ref);
	if (!parsed)
		return { ok: false, message: `模型须写成 厂商/模型 或 group/<id>：${ref}` };
	const providers = await listProviders(s);
	const single = (provider: string, model: string): UpstreamTarget | null => {
		const row = providers.find((p) => p.name === provider);
		if (!row?.exposedModels.includes(model)) return null;
		return { ...upstreamOf(row), model };
	};
	if (parsed.kind === "model") {
		const t = single(parsed.provider, parsed.model);
		return t
			? { ok: true, targets: [t], groupId: null }
			: { ok: false, message: `模型 ${ref} 未在本组织开放` };
	}
	const group = isUuid(parsed.groupId)
		? await s.first(modelGroups, eq(modelGroups.id, parsed.groupId))
		: undefined;
	if (!group) return { ok: false, message: `路由组 ${ref} 不存在` };
	const members = group.members.flatMap((m) => {
		const r = parseModelRef(m);
		const t = r?.kind === "model" ? single(r.provider, r.model) : null;
		return t ? [t] : [];
	});
	if (members.length === 0)
		return { ok: false, message: `路由组“${group.name}”里没有可用的模型` };
	return {
		ok: true,
		targets:
			(group.routing as GroupRouting) === "rotate" && advance
				? rotate(group.id, members)
				: members,
		groupId: group.id,
	};
}

/** 模型引用在本租户可用，否则 400 MODEL_UNAVAILABLE。 */
export async function requireAvailableModel(
	s: Scoped,
	ref: string,
): Promise<void> {
	const parsed = parseModelRef(ref);
	if (parsed?.kind === "group") {
		const r = await resolveModel(s, ref, false);
		if (r.ok) return;
		throw new AppError(400, ERROR_CODES.MODEL_UNAVAILABLE, r.message);
	}
	const options = await modelOptions(s);
	if (!options.some((o) => o.ref === ref))
		throw new AppError(
			400,
			ERROR_CODES.MODEL_UNAVAILABLE,
			`模型 ${ref} 未在本组织开放`,
		);
}
