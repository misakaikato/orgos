/**
 * 浏览器 WS `/ws` 的连接逻辑（与 Bun 无关，便于在 node 下测试）。
 *
 * 鉴权：cookie，或 `?token=<better-auth 会话 token>`（等价于 `Authorization: Bearer`）。
 * 先完成升级再以关闭码告知失败（浏览器拿不到升级失败的 HTTP 状态）：
 * 未登录 4401，已登录但未入驻 4404。成功后按本人主体登记到 hub，只收推送，不收消息。
 */
import { WS_CLOSE } from "@orgos/protocol";
import type { WSContext, WSEvents } from "hono/ws";
import { identityOf, sessionUserOf } from "@/middleware/auth";
import {
	type BrowserHub,
	browserHub,
	type HubSocket,
} from "@/realtime/browser-hub";

export type BrowserWsAuth =
	| { ok: true; principalId: string }
	| { ok: false; closeCode: number; reason: string };

export async function authenticateBrowserWs(
	req: Request,
): Promise<BrowserWsAuth> {
	const headers = new Headers(req.headers);
	const token = new URL(req.url).searchParams.get("token");
	if (token) headers.set("authorization", `Bearer ${token}`);
	const user = await sessionUserOf(headers);
	if (!user) {
		return {
			ok: false,
			closeCode: WS_CLOSE.UNAUTHORIZED,
			reason: "unauthorized",
		};
	}
	const identity = await identityOf(user.id);
	if (!identity) {
		return {
			ok: false,
			closeCode: WS_CLOSE.NOT_ONBOARDED,
			reason: "not onboarded",
		};
	}
	return { ok: true, principalId: identity.principal.id };
}

/**
 * 每条连接只包一次 WSContext：hub 按对象引用区分连接，
 * onOpen 与 onClose 必须拿到同一个包装，否则 detach 永远匹配不上。
 */
function socketHolder(): (ws: WSContext) => HubSocket {
	let sock: HubSocket | null = null;
	return (ws) => {
		if (!sock) {
			sock = {
				send: (data) => ws.send(data),
				close: (code, reason) => ws.close(code, reason),
			};
		}
		return sock;
	};
}

export async function browserWsEvents(
	req: Request,
	hub: BrowserHub = browserHub,
): Promise<WSEvents> {
	const auth = await authenticateBrowserWs(req);
	const hold = socketHolder();
	return {
		onOpen: (_evt, ws) => {
			if (!auth.ok) {
				ws.close(auth.closeCode, auth.reason);
				return;
			}
			hub.attach(auth.principalId, hold(ws));
		},
		onClose: (_evt, ws) => {
			if (auth.ok) hub.detach(auth.principalId, hold(ws));
		},
	};
}
