/**
 * 测试前把 orgos_test 重置为空库并应用全部迁移，使每轮测试从同一基线出发。
 * 只接受库名以 _test 结尾的连接串，防止误清开发库。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "../vitest.config";

const migrationsFolder = path.resolve(
	fileURLToPath(new URL("./", import.meta.url)),
	"../drizzle",
);

export default async function globalSetup(): Promise<void> {
	const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
	if (!dbName.endsWith("_test")) {
		throw new Error(`拒绝重置非测试库：${dbName}`);
	}
	const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
	try {
		await sql`drop schema if exists drizzle cascade`;
		await sql`drop schema public cascade`;
		await sql`create schema public`;
		await migrate(drizzle(sql), { migrationsFolder });
	} finally {
		await sql.end();
	}
}
