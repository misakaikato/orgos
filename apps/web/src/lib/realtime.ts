"use client";

/**
 * 浏览器 WS：只收推送。断线按 1s→30s 指数退避（±20% 抖动）重连，永不放弃；
 * 每次连上都补齐（重拉会话列表 + 各已加载会话按最大 seq 拉 events?after=）。
 * 服务端每 20s 发 ping；超过 45s 没收到任何帧视为假死，主动断开重连。
 */
import { parseBrowserFrame, WS_CLOSE } from "@orgos/protocol";
import { wsUrl } from "@/lib/auth-mode";
import {
	applyAgentFrame,
	applyEvent,
	applyPresence,
	applyRunner,
	applyTask,
	applyWorkItem,
	markNotOnboarded,
	markUnauthorized,
	resync,
	setConnection,
} from "@/lib/store";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const JITTER = 0.2;
const SILENCE_LIMIT_MS = 45_000;

export function backoffDelay(attempt: number, random = Math.random): number {
	const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
	return Math.round(base * (1 + (random() * 2 - 1) * JITTER));
}

/** 建立连接并保持；返回停止函数。 */
export function startRealtime(): () => void {
	let socket: WebSocket | null = null;
	let attempt = 0;
	let stopped = false;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let silenceTimer: ReturnType<typeof setTimeout> | null = null;

	const armSilence = (ws: WebSocket) => {
		if (silenceTimer) clearTimeout(silenceTimer);
		silenceTimer = setTimeout(() => ws.close(), SILENCE_LIMIT_MS);
	};

	const connect = () => {
		if (stopped) return;
		setConnection(attempt === 0 ? "connecting" : "reconnecting");
		const ws = new WebSocket(wsUrl(window.location));
		socket = ws;

		ws.onopen = () => {
			attempt = 0;
			setConnection("open");
			armSilence(ws);
			void resync().catch(() => ws.close());
		};
		ws.onmessage = (ev) => {
			armSilence(ws);
			if (typeof ev.data !== "string") return;
			const frame = parseBrowserFrame(ev.data);
			if (!frame.ok) return;
			const data = frame.data;
			if (data.t === "event") applyEvent(data.event);
			else if (data.t === "presence")
				applyPresence(data.principalId, data.status);
			else if (data.t === "draft" || data.t === "status") applyAgentFrame(data);
			else if (data.t === "work_item") applyWorkItem(data.workItem);
			else if (data.t === "runner") applyRunner(data.runner);
			else if (data.t === "task") applyTask(data.task);
		};
		ws.onclose = (ev) => {
			if (silenceTimer) clearTimeout(silenceTimer);
			if (socket === ws) socket = null;
			if (stopped) return;
			if (ev.code === WS_CLOSE.UNAUTHORIZED) return markUnauthorized();
			if (ev.code === WS_CLOSE.NOT_ONBOARDED) return markNotOnboarded();
			setConnection("reconnecting");
			retryTimer = setTimeout(connect, backoffDelay(attempt));
			attempt += 1;
		};
	};

	connect();

	return () => {
		stopped = true;
		if (retryTimer) clearTimeout(retryTimer);
		if (silenceTimer) clearTimeout(silenceTimer);
		socket?.close();
	};
}
