/**
 * 取 hono/bun 的 upgradeWebSocket 的唯一入口。
 *
 * 必须动态 import：`hono/bun` 在模块顶层解构 `Bun`，静态导入会让 node 下的 vitest
 * 在求值阶段就挂掉（哪怕用例根本不碰 WS）。调用时才 import，Bun 运行期正常解析。
 */
import type { Context } from "hono";
import type { WSEvents } from "hono/ws";

export async function upgradeWs(c: Context, events: WSEvents) {
	const { upgradeWebSocket } = await import("hono/bun");
	return upgradeWebSocket(c, events);
}
