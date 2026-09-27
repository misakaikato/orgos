/**
 * Runner → 服务端的 WebSocket 桥（自愈：任何异常状态都必回到重连阶梯）。
 *
 * - 连 ${server}/runner/ws?token=${token}（Bun 全局 WebSocket）。
 * - 上下行都过 protocol schema 校验（下行不合法丢弃，上行不合法不发）。
 * - 每次连上（含重连）先发 hello，服务端据此判定设备在线。
 * - 断线退避重连 1s → 30s（指数 + 20% 抖动，永不放弃）。
 * - 上行在非 open 状态丢弃（不补发）。
 *
 * 连接的死亡判定由本模块自己下，不依赖对端或底层库的事件（对端消失时 close 握手可能永远等不到，
 * socket 停在 CLOSING，onclose 永不触发）：
 *   1. 每个 socket 有代号 gen；任何来自非当前 gen 的事件一律忽略。
 *   2. onerror / onclose / 连接超时 / 心跳超时 —— 四条路都走同一个 fail()，
 *      fail() 立刻摘掉旧 socket（best-effort close，不等结果）并排重连。
 *   3. CONNECT_TIMEOUT_MS 守住"连不上也不报错"（CONNECTING 卡死）。
 *   4. 心跳 ping/pong 守住"socket 静默死亡"（OPEN 但对端已不存在）：
 *      每 HEARTBEAT_MS 发一个 ping，PONG_TIMEOUT_MS 内收不到 pong 即判死。
 */
import {
	parseRunnerDown,
	type RunnerDown,
	type RunnerUp,
	RunnerUpSchema,
} from "@orgos/protocol";
import { errFields, log } from "@/log";

const OPEN = 1;

/** 连上后仍未 open 的最长等待（CONNECTING 卡死保护）。 */
const CONNECT_TIMEOUT_MS = 15_000;
/** 心跳间隔：OPEN 状态下每隔这么久发一次 ping。 */
const HEARTBEAT_MS = 20_000;
/** 发出 ping 后等待 pong 的最长时间；超时即判链路已死。 */
const PONG_TIMEOUT_MS = 15_000;
/** 重连退避下限 / 上限。 */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

type Hello = Extract<RunnerUp, { t: "hello" }>;

export interface BridgeHandlers {
	/** 每次连上都发的 hello。 */
	hello: () => Hello;
	onDown: (msg: Exclude<RunnerDown, { t: "pong" }>) => void;
	onOpen?: () => void;
	/** 服务端关闭了连接（带关闭码，例如设备被吊销的 4003）。 */
	onServerClose?: (code: number) => void;
}

export interface WsBridge {
	send(up: RunnerUp): void;
	/** 当前是否处于 OPEN（诊断/测试用）。 */
	isOpen(): boolean;
	close(): void;
}

/** Bun 全局 WebSocket 用到的子集。 */
export interface RunnerWebSocket {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onclose: ((ev: { code: number; reason: string }) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onerror: (() => void) | null;
}

export type WebSocketFactory = (url: string) => RunnerWebSocket;

/** 可注入项（测试用；运行期全部走默认值）。 */
export interface WsBridgeOptions {
	createSocket?: WebSocketFactory;
	connectTimeoutMs?: number;
	heartbeatMs?: number;
	pongTimeoutMs?: number;
	backoffMinMs?: number;
	backoffMaxMs?: number;
	/** 退避抖动系数（0 = 关闭抖动，测试用确定性）。默认 0.2。 */
	jitter?: number;
}

function defaultFactory(): WebSocketFactory {
	return (url: string) => new WebSocket(url) as unknown as RunnerWebSocket;
}

/** 服务端地址 → Runner WS 地址（http→ws、https→wss）。 */
export function runnerWsUrl(server: string): string {
	const url = new URL("/runner/ws", server);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

export function startWsBridge(
	server: string,
	token: string,
	h: BridgeHandlers,
	opts: WsBridgeOptions = {},
): WsBridge {
	const createSocket = opts.createSocket ?? defaultFactory();
	const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
	const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
	const pongTimeoutMs = opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;
	const backoffMinMs = opts.backoffMinMs ?? BACKOFF_MIN_MS;
	const backoffMaxMs = opts.backoffMaxMs ?? BACKOFF_MAX_MS;
	const jitter = opts.jitter ?? 0.2;

	const safeUrl = runnerWsUrl(server);
	// token 绝不进日志：只记不带查询串的地址。
	const url = `${safeUrl}?token=${encodeURIComponent(token)}`;

	let ws: RunnerWebSocket | null = null;
	/** 当前 socket 的代号；fail() 会自增，旧 socket 的迟到事件据此被忽略。 */
	let gen = 0;
	let stopped = false;
	let open = false;
	let backoff = backoffMinMs;
	let attempts = 0;

	let connectTimer: ReturnType<typeof setTimeout> | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let pongTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	const clearTimer = (t: ReturnType<typeof setTimeout> | null) => {
		if (t) clearTimeout(t);
	};

	const clearConnectionTimers = () => {
		clearTimer(connectTimer);
		connectTimer = null;
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = null;
		clearTimer(pongTimer);
		pongTimer = null;
	};

	const rawSend = (target: RunnerWebSocket | null, up: RunnerUp): boolean => {
		try {
			target?.send(JSON.stringify(up));
			return true;
		} catch (err) {
			log.warn("ws.send_failed", { t: up.t, ...errFields(err) });
			return false;
		}
	};

	/**
	 * 判定当前连接已死：摘旧 socket（不等 close 握手）+ 排重连。
	 * 幂等：同一 gen 只生效一次；旧 gen 的迟到事件直接忽略。
	 */
	const fail = (myGen: number, reason: string): void => {
		if (stopped || myGen !== gen) return;
		gen += 1;
		const dead = ws;
		ws = null;
		const wasOpen = open;
		open = false;
		clearConnectionTimers();
		if (dead) {
			// 先摘事件（避免这个已判死的 socket 再回调进来），再 best-effort close。
			dead.onopen = null;
			dead.onclose = null;
			dead.onmessage = null;
			dead.onerror = null;
			try {
				dead.close();
			} catch {}
		}
		log.warn("ws.disconnected", {
			reason,
			wasOpen,
			readyState: dead?.readyState ?? null,
		});
		scheduleReconnect();
	};

	const startHeartbeat = (myGen: number): void => {
		heartbeatTimer = setInterval(() => {
			if (stopped || myGen !== gen || !open) return;
			// 上一轮 ping 的 pong 还没回来就不再叠加（pongTimer 已在计时）。
			if (pongTimer) return;
			if (!rawSend(ws, { t: "ping" })) {
				fail(myGen, "heartbeat send failed");
				return;
			}
			log.debug("ws.ping");
			pongTimer = setTimeout(() => {
				pongTimer = null;
				fail(myGen, `pong timeout after ${pongTimeoutMs}ms`);
			}, pongTimeoutMs);
		}, heartbeatMs);
	};

	const connect = (): void => {
		if (stopped) return;
		const myGen = gen;
		attempts += 1;
		log.info("ws.connecting", { url: safeUrl, attempt: attempts });

		let socket: RunnerWebSocket;
		try {
			socket = createSocket(url);
		} catch (err) {
			// 构造即抛（URL 非法 / 资源耗尽）：也必须回到重连阶梯，不能让异常逃逸。
			log.error("ws.construct_failed", errFields(err));
			fail(myGen, "construct failed");
			return;
		}
		ws = socket;

		// CONNECTING 卡死保护：到点还没 open 就判死重来。
		connectTimer = setTimeout(() => {
			connectTimer = null;
			fail(myGen, `connect timeout after ${connectTimeoutMs}ms`);
		}, connectTimeoutMs);

		socket.onopen = () => {
			if (stopped || myGen !== gen) return;
			clearTimer(connectTimer);
			connectTimer = null;
			open = true;
			backoff = backoffMinMs;
			log.info("ws.open", { attempt: attempts });
			// 每次连上都先声明自己：服务端据 hello 判定设备在线。
			rawSend(socket, h.hello());
			startHeartbeat(myGen);
			h.onOpen?.();
		};

		socket.onmessage = (ev) => {
			if (stopped || myGen !== gen) return;
			const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
			const parsed = parseRunnerDown(raw);
			if (!parsed.ok) {
				log.warn("ws.down_invalid", { error: parsed.error });
				return;
			}
			// 心跳应答在桥内消化，不外泄给业务分发。
			if (parsed.data.t === "pong") {
				clearTimer(pongTimer);
				pongTimer = null;
				log.debug("ws.pong");
				return;
			}
			try {
				h.onDown(parsed.data);
			} catch (err) {
				// 业务分发抛错不得连累连接（否则又是一次"静默死亡"）。
				log.error("ws.down_handler_failed", {
					t: parsed.data.t,
					...errFields(err),
				});
			}
		};

		socket.onclose = (ev) => {
			if (myGen === gen && typeof ev?.code === "number")
				h.onServerClose?.(ev.code);
			fail(myGen, `close event ${ev?.code ?? ""} ${ev?.reason ?? ""}`.trim());
		};
		socket.onerror = () => fail(myGen, "error event");
	};

	const scheduleReconnect = (): void => {
		if (stopped || reconnectTimer) return;
		const spread = backoff * jitter;
		const wait = Math.round(backoff + (Math.random() * 2 - 1) * spread);
		backoff = Math.min(backoff * 2, backoffMaxMs);
		const delay = Math.max(0, wait);
		log.info("ws.reconnect_scheduled", { inMs: delay });
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, delay);
	};

	connect();

	return {
		send(up) {
			// 出厂前自校验，schema 不合的上行永不上线。
			const v = RunnerUpSchema.safeParse(up);
			if (!v.success) {
				log.warn("ws.up_malformed", { error: v.error.message });
				return;
			}
			if (!open || !ws || ws.readyState !== OPEN) {
				log.debug("ws.up_dropped_offline", { t: up.t });
				return;
			}
			rawSend(ws, up);
		},
		isOpen: () => open,
		close() {
			stopped = true;
			open = false;
			clearConnectionTimers();
			clearTimer(reconnectTimer);
			reconnectTimer = null;
			log.info("ws.closed_by_runner");
			try {
				ws?.close();
			} catch {}
			ws = null;
		},
	};
}
