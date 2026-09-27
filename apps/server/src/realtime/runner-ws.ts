/**
 * 设备 Runner 的 WS `/runner/ws?token=` 连接逻辑（与 Bun 无关，便于在 node 下测试）。
 *
 * 鉴权在升级之前：token 无效或设备已吊销直接回 HTTP 401，不升级。
 * 连上后收到 hello 才算上线（登记到 hub、记下能力）；当前连接断开即下线。
 * 外部助手的上行帧（acp_*）交给外部会话服务；hello 里上报的在跑会话槽据此对账。
 */
import { parseRunnerUp, RUNNER_WS_CLOSE } from "@orgos/protocol";
import type { WSContext, WSEvents } from "hono/ws";
import { findActiveRunnerByTokenHash, type RunnerRow } from "@/db/scope";
import {
	type RunnerHub,
	type RunnerSocket,
	runnerHub,
} from "@/realtime/runner-hub";
import { externalSessions } from "@/services/external-sessions";
import {
	hashSecret,
	markRunnerOffline,
	markRunnerOnline,
	updateRunnerCapabilities,
} from "@/services/runners";

/** 由 token 认出设备；无效或已吊销返回 null。 */
export async function authenticateRunner(
	token: string | undefined,
): Promise<RunnerRow | null> {
	if (!token) return null;
	return (await findActiveRunnerByTokenHash(hashSecret(token))) ?? null;
}

/** 每条连接只包一次 WSContext：hub 按对象引用区分连接。 */
function socketHolder(): (ws: WSContext) => RunnerSocket {
	let sock: RunnerSocket | null = null;
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

export function runnerWsEvents(
	runner: RunnerRow,
	hub: RunnerHub = runnerHub,
): WSEvents {
	const hold = socketHolder();
	return {
		onMessage: async (evt, ws) => {
			if (typeof evt.data !== "string") return;
			const parsed = parseRunnerUp(evt.data);
			if (!parsed.ok) return;
			const sock = hold(ws);
			const frame = parsed.data;
			if (
				frame.t === "acp_event" ||
				frame.t === "acp_permission" ||
				frame.t === "acp_turn_end"
			) {
				await externalSessions.onRunnerFrame(runner, frame);
				return;
			}
			if (frame.t === "capabilities") {
				if (hub.isCurrent(runner.id, sock))
					await updateRunnerCapabilities(runner, frame.capabilities);
				return;
			}
			if (frame.t !== "hello") {
				hub.onFrame(runner.id, sock, frame);
				return;
			}
			hub.attach(runner.id, sock);
			if (!(await markRunnerOnline(runner, frame))) {
				hub.kick(runner.id, RUNNER_WS_CLOSE.REVOKED, "revoked");
				return;
			}
			await externalSessions.onRunnerHello(runner, frame.acpTasks ?? []);
		},
		onClose: async (_evt, ws) => {
			if (hub.detach(runner.id, hold(ws))) await markRunnerOffline(runner);
		},
	};
}
