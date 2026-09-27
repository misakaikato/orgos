/**
 * 把零件接成一个可用的 ACP Client（每个零件都能单独测，这里只负责接线与次序）：
 *   `@/acp/spawn`            起第三方进程（env 清洗）
 *   `@/acp/jsonrpc`          NDJSON + JSON-RPC 2.0 对等体
 *   `@/acp/handshake`        能力协商状态机
 *   `@/acp/fs-bridge`        `fs/*` → 任务工作目录（与设备能力同一把路径校验）
 *   `@/acp/terminal-bridge`  `terminal/*` → 工作目录里的命令（先过审批闸门）
 *   `@/acp/events`           `session/update` → 任务过程记录
 *   `@/acp/history`          流式文字合成成段
 *
 * 贯穿全文件的纪律：任何一处失败都必须收敛成一条看得见的记录。第三方进程可以崩、可以不回、
 * 可以吐一堆非协议垃圾——每一种都要变成一条 error 记录，而不是一个永远不落定的 promise。
 */
import {
	ACP_AGENT_METHODS,
	ACP_CLIENT_METHODS,
	ACP_PROTOCOL_VERSION,
	type AcpConfig,
} from "@orgos/protocol";
import { createAcpEventHandler, type EmitLog } from "@/acp/events";
import { acpReadTextFile, acpWriteTextFile } from "@/acp/fs-bridge";
import {
	type AcpHandshakeState,
	applyInitialize,
	applyNewSession,
	beginInitialize,
	canPrompt,
	close as closeHandshake,
	explainFailure,
	fail,
	INITIAL_HANDSHAKE,
} from "@/acp/handshake";
import { createTranscript } from "@/acp/history";
import { createJsonRpcPeer, type JsonRpcPeer } from "@/acp/jsonrpc";
import { type AcpProcess, buildLaunchPlan, startAcpProcess } from "@/acp/spawn";
import {
	type AcpTerminals,
	createAcpTerminals,
	type TerminalGate,
} from "@/acp/terminal-bridge";
import type {
	AcpClientCapabilities,
	AcpInitializeResponse,
	AcpNewSessionResponse,
	AcpPromptResponse,
	AcpReadTextFileParams,
	AcpRequestPermissionParams,
	AcpSessionNotification,
	AcpSessionUpdate,
	AcpWriteTextFileParams,
} from "@/acp/wire";
import { errFields, log } from "@/log";

/**
 * 我们声明的能力：fs 读写与 terminal 全开。这决定了 agent 会不会把读写与命令交给 Runner
 * （适配器按这几位决定给不给它的模型装对应工具）；关掉任何一位，agent 就改用自己的实现直接碰磁盘，
 * 工作目录限制与审批随之失效。三位全开才是安全的那一侧。
 */
export const ORGOS_CLIENT_CAPABILITIES: AcpClientCapabilities = {
	fs: { readTextFile: true, writeTextFile: true },
	terminal: true,
};

export const CLIENT_INFO = { name: "orgos-runner", version: "0.1.0" };

/** `session/prompt` 没能正常结束（会话仍在）时交回的 stopReason。 */
export const STOP_ERROR = "error";

export interface AcpClientDeps {
	config: AcpConfig;
	workspace: string;
	emit: EmitLog;
	/** agent 请求权限：交回本人所选的 optionId；null 表示取消。 */
	requestPermission: (
		params: AcpRequestPermissionParams,
	) => Promise<string | null>;
	/** agent 要开终端执行命令：先过审批。 */
	terminalGate: TerminalGate;
	/** 进程意外退出（不是我们 dispose 的）。 */
	onGone: (why: string) => void;
	baseEnv?: Record<string, string | undefined>;
	spawner?: Parameters<typeof startAcpProcess>[0]["spawner"];
}

export interface AcpClient {
	/** 起进程 + initialize + session/new。失败时不抛，状态里有原因。 */
	start(): Promise<AcpHandshakeState>;
	/** 发一轮，交回 stopReason；这一轮失败时记一条 error 并交回 `STOP_ERROR`。 */
	prompt(text: string): Promise<string>;
	/** 打断当前轮（ACP `session/cancel` 是通知，没有响应）。 */
	cancel(): void;
	state(): AcpHandshakeState;
	isPrompting(): boolean;
	dispose(): void;
}

export function createAcpClient(deps: AcpClientDeps): AcpClient {
	const { emit, workspace } = deps;
	let handshake: AcpHandshakeState = INITIAL_HANDSHAKE;
	let prompting = false;
	let disposed = false;
	let proc: AcpProcess | null = null;
	let peer: JsonRpcPeer | null = null;
	let terminals: AcpTerminals | null = null;

	const transcript = createTranscript((text) => emit("agent_text", { text }));
	const translate = createAcpEventHandler({ emit, transcript, workspace });

	const fsFailed = (title: string, err: unknown): never => {
		transcript.flush();
		emit("tool_result", {
			title,
			ok: false,
			output: err instanceof Error ? err.message : String(err),
		});
		throw err;
	};

	const handleInbound = async (
		method: string,
		params: unknown,
	): Promise<unknown> => {
		switch (method) {
			case ACP_CLIENT_METHODS.sessionUpdate: {
				const n = (params ?? {}) as AcpSessionNotification;
				translate((n.update ?? {}) as AcpSessionUpdate);
				return {};
			}
			case ACP_CLIENT_METHODS.readTextFile: {
				const p = (params ?? {}) as AcpReadTextFileParams;
				try {
					return await acpReadTextFile(workspace, p);
				} catch (e) {
					return fsFailed(`读取 ${p.path ?? ""}`, e);
				}
			}
			case ACP_CLIENT_METHODS.writeTextFile: {
				const p = (params ?? {}) as AcpWriteTextFileParams;
				try {
					const rel = await acpWriteTextFile(workspace, p);
					transcript.flush();
					emit("tool_result", { title: `写入 ${rel}`, ok: true, path: rel });
					return {};
				} catch (e) {
					return fsFailed(`写入 ${p.path ?? ""}`, e);
				}
			}
			case ACP_CLIENT_METHODS.requestPermission: {
				transcript.flush();
				const optionId = await deps.requestPermission(
					(params ?? {}) as AcpRequestPermissionParams,
				);
				return optionId
					? { outcome: { outcome: "selected", optionId } }
					: { outcome: { outcome: "cancelled" } };
			}
			case ACP_CLIENT_METHODS.terminalCreate:
				transcript.flush();
				return terminals?.create((params ?? {}) as never) ?? {};
			case ACP_CLIENT_METHODS.terminalOutput:
				return terminals?.output((params ?? {}) as never) ?? {};
			case ACP_CLIENT_METHODS.terminalWaitForExit:
				return (
					terminals?.waitForExit((params ?? {}) as never) ?? {
						exitCode: null,
						signal: null,
					}
				);
			case ACP_CLIENT_METHODS.terminalKill:
				return terminals?.kill((params ?? {}) as never) ?? {};
			case ACP_CLIENT_METHODS.terminalRelease:
				return terminals?.release((params ?? {}) as never) ?? {};
			default:
				throw new Error(`unsupported client method: ${method}`);
		}
	};

	/** 进程没了：作废全部挂起调用，让当前轮收敛，并告诉任务。 */
	const onProcessGone = (code: number | null, signal: string | null): void => {
		terminals?.disposeAll();
		if (disposed) return;
		const why = `外部助手的进程已退出（code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}）`;
		log.error("acp.process_exit", { code, signal });
		handshake = handshake.phase === "closed" ? handshake : fail(handshake, why);
		peer?.rejectAll(new Error(why));
		transcript.flush();
		deps.onGone(why);
	};

	return {
		async start() {
			const plan = buildLaunchPlan(
				deps.config,
				workspace,
				deps.baseEnv ?? process.env,
			);
			terminals = createAcpTerminals(workspace, plan.env, deps.terminalGate);
			peer = createJsonRpcPeer({
				write: (frame) => proc?.write(frame),
				handle: handleInbound,
				onProblem: (what, detail) => log.warn(`acp.${what}`, detail),
			});
			proc = startAcpProcess({
				plan,
				onStdout: (chunk) => peer?.feed(chunk),
				// 第三方进程的 stderr 是它的诊断输出，只留 Runner 日志，不进任务记录。
				onStderr: (chunk) =>
					log.debug("acp.stderr", { text: chunk.slice(0, 500) }),
				onExit: onProcessGone,
				spawner: deps.spawner,
			});

			handshake = beginInitialize(handshake);
			try {
				const init = (await peer.request(ACP_AGENT_METHODS.initialize, {
					protocolVersion: ACP_PROTOCOL_VERSION,
					clientCapabilities: ORGOS_CLIENT_CAPABILITIES,
					clientInfo: CLIENT_INFO,
				})) as AcpInitializeResponse;
				handshake = applyInitialize(handshake, init ?? {});
				const created = (await peer.request(ACP_AGENT_METHODS.newSession, {
					cwd: workspace,
					mcpServers: [],
				})) as AcpNewSessionResponse;
				handshake = applyNewSession(handshake, created?.sessionId);
				log.info("acp.session_ready", {
					agent: handshake.agentName,
					version: handshake.agentVersion,
					protocolVersion: handshake.protocolVersion,
				});
			} catch (err) {
				handshake = fail(handshake, (err as Error).message);
				log.error("acp.handshake_failed", errFields(err));
			}
			return handshake;
		},

		async prompt(text) {
			if (!canPrompt(handshake) || !peer) {
				emit("error", { message: explainFailure(handshake) });
				return STOP_ERROR;
			}
			prompting = true;
			try {
				const res = (await peer.request(ACP_AGENT_METHODS.prompt, {
					sessionId: handshake.sessionId,
					prompt: [{ type: "text", text }],
				})) as AcpPromptResponse;
				return res?.stopReason ?? "end_turn";
			} catch (err) {
				log.error("acp.prompt_failed", errFields(err));
				if (!disposed)
					emit("error", {
						message: `外部助手这一轮失败：${(err as Error).message}`,
					});
				return STOP_ERROR;
			} finally {
				prompting = false;
				transcript.flush();
			}
		},

		cancel() {
			if (!peer || !handshake.sessionId) return;
			// cancel 是通知：正在跑的 `session/prompt` 会以 stopReason "cancelled" 收敛。
			peer.notify(ACP_AGENT_METHODS.cancel, { sessionId: handshake.sessionId });
		},

		state: () => handshake,
		isPrompting: () => prompting,

		dispose() {
			disposed = true;
			transcript.dispose();
			handshake = closeHandshake(handshake);
			peer?.rejectAll(new Error("任务已结束"));
			terminals?.disposeAll();
			proc?.kill();
		},
	};
}
