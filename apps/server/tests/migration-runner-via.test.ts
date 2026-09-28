/**
 * 集成：设备来源的迁移（drizzle/0007_runner_via.sql）只新增一个可空列，已有设备的来源为空；
 * 整份迁移可重复执行。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { runners } from "@/db/schema";
import { createTeam, type TeamMember } from "./helpers";

const MIGRATION = path.resolve(
	fileURLToPath(new URL("./", import.meta.url)),
	"../drizzle/0007_runner_via.sql",
);

async function runMigration(): Promise<void> {
	const statements = readFileSync(MIGRATION, "utf8")
		.split("--> statement-breakpoint")
		.map((x) => x.trim())
		.filter(Boolean);
	for (const statement of statements) await db.execute(sql.raw(statement));
}

describe("0007_runner_via", () => {
	it("重复执行不报错；较早的设备来源为空，新写入的来源可读回", async () => {
		const [team] = (await createTeam(["Via"])) as [TeamMember];
		const [legacy] = await db
			.insert(runners)
			.values({
				tenantId: team.me.tenant.id,
				ownerId: team.me.principal.id,
				name: "旧设备",
				os: "macOS arm64",
				tokenHash: `legacy-${team.me.principal.id}`,
			})
			.returning();
		if (!legacy) throw new Error("建设备失败");
		await runMigration();
		await runMigration();
		const [after] = await db
			.select({ via: runners.via })
			.from(runners)
			.where(eq(runners.id, legacy.id));
		expect(after?.via).toBeNull();
		await db
			.update(runners)
			.set({ via: "desktop" })
			.where(eq(runners.id, legacy.id));
		const [updated] = await db
			.select({ via: runners.via })
			.from(runners)
			.where(eq(runners.id, legacy.id));
		expect(updated?.via).toBe("desktop");
	});
});
