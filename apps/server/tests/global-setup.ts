/**
 * 测试前把 orgos_test 重置为空库并应用全部迁移，使每轮测试从同一基线出发。
 * 只接受库名以 _test 结尾的连接串，防止误清开发库。
 */
import { TEST_DATABASE_URL } from "../vitest.config";
import { resetDatabase } from "./process-harness";

export default async function globalSetup(): Promise<void> {
	const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
	if (!dbName.endsWith("_test")) {
		throw new Error(`拒绝重置非测试库：${dbName}`);
	}
	await resetDatabase(TEST_DATABASE_URL);
}
