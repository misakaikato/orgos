/**
 * Bun 运行入口：`bun run src/serve.ts`。
 *
 * hono/bun 的静态导入只允许出现在这里（它不被任何测试 import），原因见 `@/lib/ws-upgrade`。
 * 心跳等进程级副作用也只在这里启动一次；此前的设备连接随上一个进程一起消失，启动时全部置为离线；
 * 上一个进程留下的进行中的运行判失败、提炼作业退回待办；此后每 10 分钟把闲置 24 小时的任务自动完成、
 * 空闲的外部会话收掉，每 15 秒拉取一次到期的记忆提炼作业。
 * 非开发模式没有 ORGOS_SECRET 拒绝启动（厂商 key 要用它加密）；开发模式下为演示租户备好 DeepSeek 厂商。
 */
import { websocket } from "hono/bun";
import { markAllRunnersOffline } from "@/db/scope";
import { ensureDemoProvider } from "@/demo/seed";
import { env, isDevMode } from "@/env";
import { assertSecretConfigured } from "@/gateway/secret";
import { app } from "@/index";
import {
	requeueInterruptedMemoryJobs,
	startMemoryWorker,
} from "@/memory/worker";
import { browserHub } from "@/realtime/browser-hub";
import { externalSessions } from "@/services/external-sessions";

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

assertSecretConfigured();
if (isDevMode() && (await ensureDemoProvider()))
	console.log("[dev] 已为演示租户建好 DeepSeek 厂商");
browserHub.startPing();
await markAllRunnersOffline();
await externalSessions.interruptAll();
await requeueInterruptedMemoryJobs();
startMemoryWorker();
setInterval(() => {
	externalSessions
		.sweepIdle()
		.catch((e) => console.error("[tasks] 自动完成闲置任务失败", e));
}, SWEEP_INTERVAL_MS);

export default {
	port: env.PORT,
	fetch: app.fetch,
	websocket,
};
