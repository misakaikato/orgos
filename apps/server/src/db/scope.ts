/**
 * 租户作用域：业务查询的唯一入口。
 *
 * `scoped(tenantId)` 给出的每个操作都自动带上 `tenant_id = $tenantId`；自定义查询（联表、排序）
 * 必须用 `where(table, ...)` 为涉及的每张业务表拼条件。路由与服务里不写不带租户条件的业务查询。
 *
 * 文件末尾的"身份解析"一节是仅有的例外：租户根表本身、登录后"我属于哪个租户"的查找，
 * 以及设备凭配对码或 token 认出自己属于哪个租户，天然发生在知道租户之前；
 * 另有进程级的维护（启动时设备置离线、找出有未结束任务或进行中运行的租户），只返回租户 id，
 * 具体处理仍经 `scoped(tenantId)`。
 */
import { TASK_ENDED_STATES } from "@orgos/protocol";
import { and, eq, gt, isNull, notInArray, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db, type Executor } from "@/db";
import {
	members,
	pairingCodes,
	principals,
	runners,
	runs,
	tasks,
	tenants,
	user,
} from "@/db/schema";

export type TenantTable = PgTable & { tenantId: PgColumn };

type Row<T extends TenantTable> = T["$inferSelect"];
type NewRow<T extends TenantTable> = Omit<T["$inferInsert"], "tenantId">;

type Conditions = (SQL | undefined)[];

export interface Scoped {
	readonly tenantId: string;
	/** 当前执行器（db 或事务），供自定义查询使用；条件一律经 `where` 拼。 */
	readonly executor: Executor;
	/** `tenant_id = $tenantId` 与附加条件的合取。 */
	where(table: TenantTable, ...conditions: Conditions): SQL;
	select<T extends TenantTable>(
		table: T,
		...conditions: Conditions
	): Promise<Row<T>[]>;
	first<T extends TenantTable>(
		table: T,
		...conditions: Conditions
	): Promise<Row<T> | undefined>;
	/** 插入一行，自动填 tenant_id。 */
	insert<T extends TenantTable>(table: T, values: NewRow<T>): Promise<Row<T>>;
	/** 在事务里以同一租户作用域执行。 */
	transaction<R>(fn: (s: Scoped) => Promise<R>): Promise<R>;
}

export function scoped(tenantId: string, executor: Executor = db): Scoped {
	function where(table: TenantTable, ...conditions: Conditions): SQL {
		return and(eq(table.tenantId, tenantId), ...conditions) as SQL;
	}

	return {
		tenantId,
		executor,
		where,

		async select<T extends TenantTable>(
			table: T,
			...conditions: Conditions
		): Promise<Row<T>[]> {
			const rows = await executor
				.select()
				.from(table as PgTable)
				.where(where(table, ...conditions));
			return rows as Row<T>[];
		},

		async first<T extends TenantTable>(
			table: T,
			...conditions: Conditions
		): Promise<Row<T> | undefined> {
			const rows = await executor
				.select()
				.from(table as PgTable)
				.where(where(table, ...conditions))
				.limit(1);
			return rows[0] as Row<T> | undefined;
		},

		async insert<T extends TenantTable>(
			table: T,
			values: NewRow<T>,
		): Promise<Row<T>> {
			const rows = (await executor
				.insert(table)
				.values({ ...values, tenantId } as T["$inferInsert"])
				.returning()) as Row<T>[];
			const row = rows[0];
			if (!row) throw new Error("insert returned no row");
			return row;
		},

		transaction<R>(fn: (s: Scoped) => Promise<R>): Promise<R> {
			return executor.transaction((tx) => fn(scoped(tenantId, tx)));
		},
	};
}

// ─────────────────────────── 身份解析（不带租户条件的例外） ───────────────────────────

export type Tenant = typeof tenants.$inferSelect;
export type Member = typeof members.$inferSelect;
export type PrincipalRow = typeof principals.$inferSelect;

/** 用户所属的租户与成员身份；尚未 onboarding 返回 null。 */
export async function findMembership(
	userId: string,
	executor: Executor = db,
): Promise<{ member: Member; tenant: Tenant } | null> {
	const rows = await executor
		.select({ member: members, tenant: tenants })
		.from(members)
		.innerJoin(tenants, eq(tenants.id, members.tenantId))
		.where(eq(members.userId, userId))
		.limit(1);
	return rows[0] ?? null;
}

export async function findTenantByInviteCode(
	inviteCode: string,
	executor: Executor = db,
): Promise<Tenant | undefined> {
	const rows = await executor
		.select()
		.from(tenants)
		.where(eq(tenants.inviteCode, inviteCode))
		.limit(1);
	return rows[0];
}

export async function createTenant(
	values: { name: string; inviteCode: string },
	executor: Executor = db,
): Promise<Tenant> {
	const rows = await executor.insert(tenants).values(values).returning();
	const row = rows[0];
	if (!row) throw new Error("insert returned no row");
	return row;
}

export async function findUserIdByEmail(
	email: string,
	executor: Executor = db,
): Promise<string | undefined> {
	const rows = await executor
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email))
		.limit(1);
	return rows[0]?.id;
}

/** 用户在其租户里的本人主体（kind=human）。 */
export async function findSelfPrincipal(
	s: Scoped,
	userId: string,
): Promise<PrincipalRow | undefined> {
	return s.first(
		principals,
		eq(principals.userId, userId),
		eq(principals.kind, "human"),
	);
}

/** 删除租户：业务表经 tenant_id 外键级联清空（演示数据重建用）。 */
export async function deleteTenant(
	tenantId: string,
	executor: Executor = db,
): Promise<void> {
	await executor.delete(tenants).where(eq(tenants.id, tenantId));
}

/** 删除 better-auth 用户；其 session / account 行经外键级联删除。须先删其租户。 */
export async function deleteUser(
	userId: string,
	executor: Executor = db,
): Promise<void> {
	await executor.delete(user).where(eq(user.id, userId));
}

export type PairingCodeRow = typeof pairingCodes.$inferSelect;
export type RunnerRow = typeof runners.$inferSelect;

/**
 * 核销一个配对码：仍未使用且未过期时原子地标记为已用并返回；否则 null。
 * 同一配对码的并发核销只有一个成功。
 */
export async function consumePairingCode(
	codeHash: string,
	now: Date,
	executor: Executor = db,
): Promise<PairingCodeRow | null> {
	const rows = await executor
		.update(pairingCodes)
		.set({ usedAt: now })
		.where(
			and(
				eq(pairingCodes.codeHash, codeHash),
				isNull(pairingCodes.usedAt),
				gt(pairingCodes.expiresAt, now),
			),
		)
		.returning();
	return rows[0] ?? null;
}

/** 按 token 哈希找未吊销的设备。 */
export async function findActiveRunnerByTokenHash(
	tokenHash: string,
	executor: Executor = db,
): Promise<RunnerRow | undefined> {
	const rows = await executor
		.select()
		.from(runners)
		.where(and(eq(runners.tokenHash, tokenHash), isNull(runners.revokedAt)))
		.limit(1);
	return rows[0];
}

/** 服务进程启动时：此前的连接都已不在，全部设备置为离线。 */
export async function markAllRunnersOffline(
	executor: Executor = db,
): Promise<void> {
	await executor
		.update(runners)
		.set({ status: "offline" })
		.where(eq(runners.status, "online"));
}

/** 有未结束任务的租户（进程启动时收尾中断的任务、定时自动完成闲置任务用）。 */
export async function tenantsWithOpenTasks(
	executor: Executor = db,
): Promise<string[]> {
	const rows = await executor
		.selectDistinct({ tenantId: tasks.tenantId })
		.from(tasks)
		.where(notInArray(tasks.state, [...TASK_ENDED_STATES]));
	return rows.map((r) => r.tenantId);
}

/** 有进行中运行的租户（进程启动时收尾上一个进程留下的运行）。 */
export async function tenantsWithRunningRuns(
	executor: Executor = db,
): Promise<string[]> {
	const rows = await executor
		.selectDistinct({ tenantId: runs.tenantId })
		.from(runs)
		.where(eq(runs.state, "running"));
	return rows.map((r) => r.tenantId);
}
