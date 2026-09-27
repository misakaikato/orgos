/**
 * 集成：记忆层的迁移（drizzle/0005_memory_layer.sql）整份可重复执行。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/db";

const MIGRATION = path.resolve(
	fileURLToPath(new URL("./", import.meta.url)),
	"../drizzle/0005_memory_layer.sql",
);

async function runMigration(): Promise<void> {
	const statements = readFileSync(MIGRATION, "utf8")
		.split("--> statement-breakpoint")
		.map((x) => x.trim())
		.filter(Boolean);
	for (const statement of statements) await db.execute(sql.raw(statement));
}

describe("0005_memory_layer", () => {
	it("在已迁移的库上再执行两遍不报错，表与可空列都在", async () => {
		await runMigration();
		await runMigration();
		const rows = await db.execute(
			sql`select table_name, column_name, is_nullable from information_schema.columns
				where (table_name = 'runs' and column_name in ('agent_id', 'acting_for_id', 'conversation_id', 'topic_id'))
				   or (table_name = 'llm_requests' and column_name = 'agent_id')
				   or (table_name = 'memory_items' and column_name = 'embedding')`,
		);
		const list = [...rows] as { is_nullable: string }[];
		expect(list).toHaveLength(6);
		expect(list.every((r) => r.is_nullable === "YES")).toBe(true);
		const tables = await db.execute(
			sql`select count(*)::int as n from information_schema.tables
				where table_name in ('memory_items', 'memory_profiles', 'memory_jobs', 'disclosure_rules')`,
		);
		expect(([...tables][0] as { n: number }).n).toBe(4);
	});
});
