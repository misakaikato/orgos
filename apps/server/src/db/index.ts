import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { env } from "@/env";

const client = postgres(env.DATABASE_URL, { max: 10 });

export const db = drizzle(client, { schema });
export type DB = typeof db;
/** 事务句柄与 db 共用的查询面。 */
export type Executor = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

/** 关闭连接池（脚本结束时调用）。 */
export async function closeDb(): Promise<void> {
	await client.end();
}
