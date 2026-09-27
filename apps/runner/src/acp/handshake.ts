/**
 * 能力协商状态机（纯函数，零 IO）。
 *
 * ACP 的开局有严格次序：`initialize` 谈能力 → `session/new` 建会话 → 才能 `session/prompt`。
 * 做成一台可以离线穷举的状态机，而不是散在 client 里的几个布尔量：
 *
 *   1. 失败形态比成功形态多：协议版本对不上、agent 要求先登录（`authMethods` 非空且它拒绝建会话）、
 *      进程中途死掉——每一种都要有确定的对外表现，而不是"某个 promise 不落定"；
 *   2. "这一刻能不能发 prompt"会被四处询问（下行分发、追问排队、打断），纯函数是挡住竞态的最便宜手段。
 */
import { ACP_PROTOCOL_VERSION } from "@orgos/protocol";
import type { AcpAuthMethod, AcpInitializeResponse } from "@/acp/wire";

/**
 * 握手阶段。
 *   - `idle`         进程刚起，还没发 initialize
 *   - `initializing` initialize 已发出，等响应
 *   - `negotiated`   能力已谈妥，还没建会话
 *   - `ready`        session/new 完成，可以发 prompt
 *   - `failed`       任一步失败（`error` 里有人话原因）
 *   - `closed`       进程已退出 / 会话已释放
 */
export type AcpPhase =
	| "idle"
	| "initializing"
	| "negotiated"
	| "ready"
	| "failed"
	| "closed";

export interface AcpHandshakeState {
	phase: AcpPhase;
	/** agent 报回来的协议版本（未协商时 null）。 */
	protocolVersion: number | null;
	/** agent 自报家门（`agentInfo`）。 */
	agentName: string | null;
	agentVersion: string | null;
	/** agent 声明的登录方式。非空 = 它要本人自己的凭据。 */
	authMethods: AcpAuthMethod[];
	sessionId: string | null;
	/** 失败原因（人话，可以直接给人看）。 */
	error: string | null;
	/**
	 * 协议版本不一致时的说明（不是失败）：对方比我们新一位并不意味着
	 * initialize / new / prompt 三件套会变，真出问题时后续调用会给出更具体的错误。
	 */
	versionWarning: string | null;
}

export const INITIAL_HANDSHAKE: AcpHandshakeState = {
	phase: "idle",
	protocolVersion: null,
	agentName: null,
	agentVersion: null,
	authMethods: [],
	sessionId: null,
	error: null,
	versionWarning: null,
};

/** 这一刻能不能发 prompt。 */
export function canPrompt(state: AcpHandshakeState): boolean {
	return state.phase === "ready" && state.sessionId !== null;
}

/** 发出 initialize 那一刻。 */
export function beginInitialize(state: AcpHandshakeState): AcpHandshakeState {
	if (state.phase !== "idle") return state;
	return { ...state, phase: "initializing" };
}

/** 收到 initialize 响应：如实读回对方报的版本，不一致时记一条说明继续。 */
export function applyInitialize(
	state: AcpHandshakeState,
	res: AcpInitializeResponse,
): AcpHandshakeState {
	const version =
		typeof res.protocolVersion === "number" ? res.protocolVersion : null;
	return {
		...state,
		phase: "negotiated",
		protocolVersion: version,
		agentName: res.agentInfo?.title ?? res.agentInfo?.name ?? null,
		agentVersion: res.agentInfo?.version ?? null,
		authMethods: res.authMethods ?? [],
		versionWarning:
			version !== null && version !== ACP_PROTOCOL_VERSION
				? `外部助手报的 ACP 协议版本是 ${version}，orgos 实现的是 ${ACP_PROTOCOL_VERSION}；已按 ${ACP_PROTOCOL_VERSION} 继续，若行为异常请先看这一条。`
				: null,
	};
}

/** 收到 session/new 响应。没有 sessionId = 建会话失败（对方回了个空壳）。 */
export function applyNewSession(
	state: AcpHandshakeState,
	sessionId: string | null | undefined,
): AcpHandshakeState {
	if (!sessionId) {
		return fail(state, "外部助手没有返回 sessionId，会话无法建立");
	}
	return { ...state, phase: "ready", sessionId };
}

/** 任一步失败。已经 closed 就不再改：进程正常退出之后不该被一条迟到的错误改写成"失败"。 */
export function fail(
	state: AcpHandshakeState,
	error: string,
): AcpHandshakeState {
	if (state.phase === "closed") return state;
	return { ...state, phase: "failed", error };
}

/** 进程退出 / 会话释放。 */
export function close(state: AcpHandshakeState): AcpHandshakeState {
	return { ...state, phase: "closed", sessionId: null };
}

/**
 * 握手失败时给本人的那句话。agent 声明了 `authMethods` 说明它要本人自己的凭据：
 * 光说"建会话失败"没用，得告诉本人去哪儿登录（orgos 不代管任何凭据）。
 */
export function explainFailure(state: AcpHandshakeState): string {
	const base = state.error ?? "外部助手启动失败";
	if (state.authMethods.length === 0) return base;
	const ways = state.authMethods
		.map((m) => m.description ?? m.name ?? m.id)
		.join("；");
	return `${base}。这个外部助手需要本人在这台设备上自己登录（orgos 不会替它提供任何凭据）：${ways}。`;
}
