/**
 * 浏览器 WS 连接集合：按本人主体登记连接，向指定主体推送帧。
 *
 * 纯逻辑，不依赖 Bun / Hono / 数据库。连接以对象引用区分：路由层每条连接只包一次
 * （见 `@/realtime/browser-ws` 的 socketHolder），attach 与 detach 必须传同一个对象。
 */
import { BROWSER_PING_INTERVAL_MS, type BrowserFrame } from "@orgos/protocol";

export interface HubSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export class BrowserHub {
	private readonly byPrincipal = new Map<string, Set<HubSocket>>();
	private pingTimer: ReturnType<typeof setInterval> | null = null;

	attach(principalId: string, sock: HubSocket): void {
		let set = this.byPrincipal.get(principalId);
		if (!set) {
			set = new Set();
			this.byPrincipal.set(principalId, set);
		}
		set.add(sock);
	}

	detach(principalId: string, sock: HubSocket): void {
		const set = this.byPrincipal.get(principalId);
		if (!set) return;
		set.delete(sock);
		if (set.size === 0) this.byPrincipal.delete(principalId);
	}

	connectionCount(principalId: string): number {
		return this.byPrincipal.get(principalId)?.size ?? 0;
	}

	/** 向这些主体的全部连接推一帧；单条连接发送失败不影响其他连接。 */
	sendTo(principalIds: Iterable<string>, frame: BrowserFrame): void {
		const data = JSON.stringify(frame);
		for (const id of new Set(principalIds)) {
			const set = this.byPrincipal.get(id);
			if (!set) continue;
			for (const sock of set) {
				try {
					sock.send(data);
				} catch {
					// 对端已断开，由 onClose 负责 detach。
				}
			}
		}
	}

	private broadcast(frame: BrowserFrame): void {
		this.sendTo(this.byPrincipal.keys(), frame);
	}

	/** 每 20s 向所有连接发 `{t:'ping'}`；只在服务进程里启动一次。 */
	startPing(intervalMs = BROWSER_PING_INTERVAL_MS): void {
		if (this.pingTimer) return;
		this.pingTimer = setInterval(
			() => this.broadcast({ t: "ping" }),
			intervalMs,
		);
	}

	stopPing(): void {
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = null;
	}
}

export const browserHub = new BrowserHub();
