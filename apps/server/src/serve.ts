/**
 * Bun 运行入口：`bun run src/serve.ts`。
 *
 * hono/bun 的静态导入只允许出现在这里（它不被任何测试 import），原因见 `@/lib/ws-upgrade`。
 * 心跳等进程级副作用也只在这里启动一次；此前的设备连接随上一个进程一起消失，启动时全部置为离线。
 */
import { websocket } from "hono/bun";
import { markAllRunnersOffline } from "@/db/scope";
import { env } from "@/env";
import { app } from "@/index";
import { browserHub } from "@/realtime/browser-hub";

browserHub.startPing();
await markAllRunnersOffline();

export default {
	port: env.PORT,
	fetch: app.fetch,
	websocket,
};
