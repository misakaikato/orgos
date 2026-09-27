/**
 * Bun 运行入口：`bun run src/serve.ts`。
 *
 * hono/bun 的静态导入只允许出现在这里（它不被任何测试 import），原因见 `@/lib/ws-upgrade`。
 * 心跳等进程级副作用也只在这里启动一次；此前的设备连接随上一个进程一起消失，启动时全部置为离线；
 * 上一个进程留下的进行中的运行判失败；此后每 10 分钟把闲置 24 小时的任务自动完成、空闲的外部会话收掉。
 */
import { websocket } from "hono/bun";
import { markAllRunnersOffline } from "@/db/scope";
import { env } from "@/env";
import { app } from "@/index";
import { browserHub } from "@/realtime/browser-hub";
import { externalSessions } from "@/services/external-sessions";

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

browserHub.startPing();
await markAllRunnersOffline();
await externalSessions.interruptAll();
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
