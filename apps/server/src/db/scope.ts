/**
 * 租户作用域：业务查询的唯一入口。
 *
 * `scoped(tenantId)` 给出的每个操作都自动带上 `tenant_id = $tenantId`；自定义查询（联表、排序）
 * 必须用 `where(table, ...)` 为涉及的每张业务表拼条件。路由与服务里不写不带租户条件的业务查询。
 *
 * 文件末尾的"身份解析"一节是仅有的例外：租户根表本身，以及登录后"我属于哪个租户"的查找，
 * 天然发生在知道租户之前。
 */
import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db, type Executor } from "@/db";
import { members, principals, tenants, user } from "@/db/schema";

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
