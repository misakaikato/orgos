/**
 * WebSocket 反向代理（浏览器 ⇄ 服务端 ⇄ 内部 Next）。
 *
 * Next dev 的 HMR 走 WebSocket，而 proxyToNext 是 fetch 转发、不认 upgrade：不透传的话握手失败，
 * 页面渲染出来却永不水合。服务端接住浏览器的升级，再以标准 WebSocket 客户端连内部目标，
 * 两端逐帧互转。上游连上前到达的浏览器帧先入队，连上后按序补发（Next dev 客户端握手后立即发帧）。
 */
import type { WSEvents } from "hono/ws";

type WsPayload = string | ArrayBuffer | Uint8Array<ArrayBuffer>;

async function toWsPayload(data: unknown): Promise<WsPayload | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return data;
	if (data instanceof Uint8Array) return new Uint8Array(data);
	if (typeof Blob !== "undefined" && data instanceof Blob) {
		return new Uint8Array(await data.arrayBuffer());
	}
	return null;
}

/** 把浏览器 WS 双向桥接到 `targetUrl`；任一端关闭或出错即关另一端。 */
export function wsProxyEvents(targetUrl: string): WSEvents {
	let backend: WebSocket | null = null;
	let closed = false;
	const pending: WsPayload[] = [];

	return {
		onOpen: (_evt, ws) => {
			const sock = new WebSocket(targetUrl);
			backend = sock;
			sock.onopen = () => {
				for (const p of pending.splice(0)) {
					try {
						sock.send(p);
					} catch {}
				}
			};
			sock.onmessage = async (ev) => {
				const payload = await toWsPayload(ev.data);
				if (payload === null) return;
				try {
					ws.send(payload);
				} catch {}
			};
			const closeBrowser = () => {
				closed = true;
				try {
					ws.close();
				} catch {}
			};
			sock.onclose = closeBrowser;
			sock.onerror = closeBrowser;
		},
		onMessage: async (evt) => {
			const payload = await toWsPayload(evt.data);
			if (payload === null || closed) return;
			const sock = backend;
			if (!sock || sock.readyState !== WebSocket.OPEN) {
				pending.push(payload);
				return;
			}
			try {
				sock.send(payload);
			} catch {}
		},
		onClose: () => {
			closed = true;
			try {
				backend?.close();
			} catch {}
		},
	};
}
