/**
 * 集成：企业模型网关的迁移（drizzle/0004_model_gateway.sql）把代理的旧模型值（裸模型 id，
 * 此前只接 DeepSeek）改写为模型引用 `deepseek/<id>`，已是引用的不动；整份迁移可重复执行。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { createTeam, type TeamMember } from "./helpers";

const MIGRATION = path.resolve(
	fileURLToPath(new URL("./", import.meta.url)),
	"../drizzle/0004_model_gateway.sql",
);

async function runMigration(): Promise<void> {
	const statements = readFileSync(MIGRATION, "utf8")
		.split("--> statement-breakpoint")
		.map((x) => x.trim())
		.filter(Boolean);
	for (const statement of statements) await db.execute(sql.raw(statement));
}

let team: TeamMember;
let twin: string;
let ops: string;

async function modelOf(id: string): Promise<string | undefined> {
	const [row] = await db
		.select({ model: agents.model })
		.from(agents)
		.where(eq(agents.principalId, id));
	return row?.model;
}

beforeAll(async () => {
	[team] = (await createTeam(["Mig"])) as [TeamMember];
	twin = team.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
	ops = team.me.agents.find((a) => a.role === "specialist")?.principal.id ?? "";
	await db
		.update(agents)
		.set({ model: "deepseek-v4-pro" })
		.where(eq(agents.principalId, twin));
	await db
		.update(agents)
		.set({ model: "oa/m-large" })
		.where(eq(agents.principalId, ops));
});

describe("0004_model_gateway", () => {
	it("裸模型 id 改写为 deepseek/<id>，已是模型引用的不动；重复执行结果不变", async () => {
		await runMigration();
		expect(await modelOf(twin)).toBe("deepseek/deepseek-v4-pro");
		expect(await modelOf(ops)).toBe("oa/m-large");
		await runMigration();
		expect(await modelOf(twin)).toBe("deepseek/deepseek-v4-pro");
	});
});
