/**
 * 演示数据（幂等）：删除并重建租户"星河科技"（linxiao、zhouye、chenan、xunuo）与
 * "别家公司"（waibu）的全部数据，包括预置会话、待办与资料。不影响其他租户。
 * 实现在 apps/server/src/demo/，与模拟台的"重置演示数据"共用同一个函数。
 *
 * 有 DeepSeek key 时（与 bun run dev 同一个来源）顺带为演示主租户建好 DeepSeek 厂商，
 * 否则演示租户重建后没有任何模型可用。
 *
 * 运行：bun run seed:demo（需先 bun run dev:db && bun run db:migrate）。
 */
import { closeDb } from "@/db";
import { DEMO_TENANTS } from "@/demo/people";
import { DEMO_PASSWORD, resetDemo } from "@/demo/seed";
import { resolveDeepseekKey } from "./deepseek-key";

const deepseek = await resolveDeepseekKey();
if (deepseek) process.env.DEEPSEEK_API_KEY = deepseek.key;

try {
	const counts = await resetDemo();
	for (const t of DEMO_TENANTS) {
		const handles = t.people.map((p) => p.handle).join("、");
		console.log(`[seed:demo] ${t.orgName}：${handles}`);
	}
	console.log(
		`[seed:demo] 星河科技：${counts.people} 人，会话 ${counts.conversations}，事件 ${counts.events}，待办（open）${counts.openWorkItems}，资料与记忆 ${counts.notes}`,
	);
	console.log(`[seed:demo] 登录：<handle>@orgos.local / ${DEMO_PASSWORD}`);
	console.log(
		deepseek
			? "[seed:demo] 已为星河科技建好 DeepSeek 厂商"
			: "[seed:demo] 没有找到 DeepSeek key，星河科技暂无模型厂商；在“模型”页添加，或设置 DEEPSEEK_API_KEY 后重跑",
	);
} finally {
	await closeDb();
}
