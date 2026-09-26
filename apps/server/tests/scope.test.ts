/**
 * 集成：scoped() 的租户隔离与 principals 的约束（真实 Postgres）。
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { principals } from "@/db/schema";
import { createTenant, findUserIdByEmail, scoped } from "@/db/scope";
import { newInviteCode } from "@/services/onboarding";
import { signUpAndIn, uniq } from "./helpers";

describe("scoped(tenantId)", () => {
	let tenantA: string;
	let tenantB: string;
	let userA: string;

	beforeAll(async () => {
		tenantA = (await createTenant({ name: "A", inviteCode: newInviteCode() }))
			.id;
		tenantB = (await createTenant({ name: "B", inviteCode: newInviteCode() }))
			.id;
		const c = await signUpAndIn();
		userA = (await findUserIdByEmail(c.email)) as string;
	});

	it("insert 自动填 tenant_id，select 只看得到本租户", async () => {
		const handle = uniq("p");
		const a = scoped(tenantA);
		const row = await a.insert(principals, {
			kind: "human",
			userId: userA,
			ownerId: null,
			handle,
			displayName: "P",
		});
		expect(row.tenantId).toBe(tenantA);
		expect(await a.first(principals, eq(principals.id, row.id))).toBeDefined();
		const b = scoped(tenantB);
		expect(
			await b.first(principals, eq(principals.id, row.id)),
		).toBeUndefined();
		expect(await b.select(principals, eq(principals.handle, handle))).toEqual(
			[],
		);
	});

	it("事务内的作用域沿用同一租户，异常时整体回滚", async () => {
		const handle = uniq("t");
		await expect(
			scoped(tenantA).transaction(async (s) => {
				await s.insert(principals, {
					kind: "human",
					userId: userA,
					ownerId: null,
					handle,
					displayName: "T",
				});
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(
			await scoped(tenantA).select(principals, eq(principals.handle, handle)),
		).toEqual([]);
	});

	it("check 约束：agent 必须有 ownerId 且无 userId，human 必须有 userId 且无 ownerId", async () => {
		const s = scoped(tenantA);
		await expect(
			s.insert(principals, {
				kind: "agent",
				userId: null,
				ownerId: null,
				handle: uniq("x"),
				displayName: "X",
			}),
		).rejects.toThrow();
		await expect(
			s.insert(principals, {
				kind: "human",
				userId: null,
				ownerId: null,
				handle: uniq("x"),
				displayName: "X",
			}),
		).rejects.toThrow();
		const human = await s.insert(principals, {
			kind: "human",
			userId: userA,
			ownerId: null,
			handle: uniq("h"),
			displayName: "H",
		});
		await expect(
			s.insert(principals, {
				kind: "human",
				userId: userA,
				ownerId: human.id,
				handle: uniq("x"),
				displayName: "X",
			}),
		).rejects.toThrow();
		const agent = await s.insert(principals, {
			kind: "agent",
			userId: null,
			ownerId: human.id,
			handle: uniq("g"),
			displayName: "G",
		});
		expect(agent.ownerId).toBe(human.id);
	});

	it("where() 生成的条件带租户", async () => {
		const rows = await db
			.select()
			.from(principals)
			.where(scoped(tenantB).where(principals));
		expect(rows.every((r) => r.tenantId === tenantB)).toBe(true);
	});
});
