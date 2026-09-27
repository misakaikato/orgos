/**
 * 演示数据："星河科技"四人与"别家公司"一人，连同预置会话、待办与资料。
 *
 * `resetDemo()` 是 `bun run seed:demo` 与 `POST /api/dev/reset-demo` 共用的唯一实现：
 * 先删除两个演示租户（业务表经外键级联）与演示用户（session / account 级联），再全部重建。
 * 业务数据一律经服务函数写入，与线上路径一致；不影响其他租户。
 */
import type {
	DemoCounts,
	DemoPerson,
	DevSessionResponse,
} from "@orgos/protocol";
import { APIError } from "better-auth/api";
import { count, eq } from "drizzle-orm";
import { auth } from "@/auth";
import {
	conversations,
	events,
	notes,
	principals,
	workItems,
} from "@/db/schema";
import {
	deleteTenant,
	deleteUser,
	findMembership,
	findSelfPrincipal,
	findUserIdByEmail,
	type PrincipalRow,
	type Scoped,
	scoped,
} from "@/db/scope";
import { writeDemoConversations } from "@/demo/conversations";
import {
	DEMO_TENANTS,
	type DemoPersonSpec,
	demoEmail,
	findDemoPerson,
} from "@/demo/people";
import { notFound } from "@/lib/errors";
import { toPrincipal } from "@/lib/serialize";
import { updateAgentProfile } from "@/services/agents";
import { createNote } from "@/services/notes";
import { onboard } from "@/services/onboarding";

/** 演示账号的统一密码：仅限本地开发库使用。 */
export const DEMO_PASSWORD = "orgos-demo-pass";

/** 演示人物在库里的三个主体。 */
export type DemoCast = {
	s: Scoped;
	human: (handle: string) => PrincipalRow;
	chief: (handle: string) => PrincipalRow;
	ops: (handle: string) => PrincipalRow;
};

/** 模拟台可扮演的人物（按人物表顺序）。 */
export function demoPeople(): DemoPerson[] {
	return DEMO_TENANTS.filter((t) => t.simulated).flatMap((t) =>
		t.people.map(({ handle, displayName, title }) => ({
			handle,
			displayName,
			title,
		})),
	);
}

const DEMO_ORG_NAMES = new Set(DEMO_TENANTS.map((t) => t.orgName));

/** 删除演示用户及其所在的演示租户。演示邮箱若出现在非演示租户里则拒绝执行。 */
async function removeDemo(): Promise<void> {
	const tenantIds = new Set<string>();
	const userIds: string[] = [];
	for (const t of DEMO_TENANTS) {
		for (const p of t.people) {
			const userId = await findUserIdByEmail(demoEmail(p.handle));
			if (!userId) continue;
			userIds.push(userId);
			const found = await findMembership(userId);
			if (!found) continue;
			if (!DEMO_ORG_NAMES.has(found.tenant.name)) {
				throw new Error(
					`${demoEmail(p.handle)} 属于非演示租户"${found.tenant.name}"，拒绝删除`,
				);
			}
			tenantIds.add(found.tenant.id);
		}
	}
	for (const id of tenantIds) await deleteTenant(id);
	for (const id of userIds) await deleteUser(id);
}

async function signUp(person: DemoPersonSpec): Promise<string> {
	const res = await auth.api.signUpEmail({
		body: {
			email: demoEmail(person.handle),
			password: DEMO_PASSWORD,
			name: person.displayName,
		},
	});
	return res.user.id;
}

/** 按 handle 取本租户主体；缺失即是种子逻辑错误。 */
function castOf(s: Scoped, rows: PrincipalRow[]): DemoCast {
	const byHandle = new Map(rows.map((r) => [r.handle, r]));
	const get = (handle: string) => {
		const row = byHandle.get(handle);
		if (!row) throw new Error(`演示主体不存在：${handle}`);
		return row;
	};
	return {
		s,
		human: (h) => get(h),
		chief: (h) => get(`${h}-chief`),
		ops: (h) => get(`${h}-ops`),
	};
}

async function buildTenant(
	spec: (typeof DEMO_TENANTS)[number],
): Promise<DemoCast> {
	let tenantId: string | undefined;
	let inviteCode: string | undefined;
	for (const person of spec.people) {
		const userId = await signUp(person);
		const res = await onboard(
			userId,
			inviteCode
				? {
						mode: "join",
						inviteCode,
						displayName: person.displayName,
						handle: person.handle,
					}
				: {
						mode: "create",
						orgName: spec.orgName,
						displayName: person.displayName,
						handle: person.handle,
					},
		);
		tenantId ??= res.tenant.id;
		inviteCode ??= res.tenant.inviteCode;
		const [chief, ops] = res.agents;
		if (!chief || !ops) throw new Error("入驻未返回两个代理");
		const s = scoped(res.tenant.id);
		await updateAgentProfile(s, chief.principal.id, {
			description: person.chiefDescription,
			delegationPolicy: person.delegationPolicy,
		});
		await updateAgentProfile(s, ops.principal.id, {
			description: person.opsDescription,
		});
		for (const note of person.sharedNotes) {
			await createNote(s, {
				ownerId: res.principal.id,
				authorId: res.principal.id,
				title: note.title,
				body: note.body,
				visibility: "shared",
			});
		}
	}
	if (!tenantId) throw new Error(`${spec.orgName} 没有成员`);
	const s = scoped(tenantId);
	return castOf(s, await s.select(principals));
}

/** 星河科技的数据量（幂等性检查与重置结果展示用）。 */
export async function demoCounts(s: Scoped): Promise<DemoCounts> {
	const n = async (
		table: Parameters<Scoped["where"]>[0],
		...conditions: Parameters<Scoped["where"]>[1][]
	) => {
		const [row] = await s.executor
			.select({ n: count() })
			.from(table)
			.where(s.where(table, ...conditions));
		return row?.n ?? 0;
	};
	return {
		people: await n(principals, eq(principals.kind, "human")),
		conversations: await n(conversations),
		events: await n(events),
		openWorkItems: await n(workItems, eq(workItems.status, "open")),
		notes: await n(notes),
	};
}

let running: Promise<DemoCounts> | null = null;

/** 删除并重建全部演示数据，返回星河科技的数据量。同一进程内并发调用共用同一次重建。 */
export function resetDemo(now = new Date()): Promise<DemoCounts> {
	running ??= (async () => {
		await removeDemo();
		const casts: DemoCast[] = [];
		for (const spec of DEMO_TENANTS) casts.push(await buildTenant(spec));
		const [main] = casts;
		if (!main) throw new Error("缺少演示主租户");
		await writeDemoConversations(main, now);
		return demoCounts(main.s);
	})().finally(() => {
		running = null;
	});
	return running;
}

/** 以演示密码代某位演示人物登录，返回 better-auth 会话 token（作 Bearer 使用）。 */
export async function signInDemo(handle: string): Promise<DevSessionResponse> {
	if (!findDemoPerson(handle)) throw notFound("不是演示人物");
	let signed: { token: string; user: { id: string } };
	try {
		signed = await auth.api.signInEmail({
			body: { email: demoEmail(handle), password: DEMO_PASSWORD },
		});
	} catch (e) {
		if (e instanceof APIError) {
			throw notFound("演示数据尚未生成，请先运行 bun run seed:demo");
		}
		throw e;
	}
	const found = await findMembership(signed.user.id);
	const principal = found
		? await findSelfPrincipal(scoped(found.tenant.id), signed.user.id)
		: undefined;
	if (!principal)
		throw notFound("演示数据尚未生成，请先运行 bun run seed:demo");
	return { token: signed.token, principal: toPrincipal(principal) };
}
