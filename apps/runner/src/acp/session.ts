/**
 * 一个会话槽一个 ACP 会话：`AcpTaskSession` 包住一个 `AcpClient`，`AcpManager` 按帧里的 taskId
 * （服务端按话题开槽，填话题 id）起停它们。
 *
 * - 起：握手成功记一条 state（带外部会话 id），然后发第一段话；失败记一条致命 error 并收掉进程；
 * - 追问：同一会话里排队，一轮结束（stopReason）上报 `acp_turn_end` 后再发下一段；
 * - 权限：agent 的 `session/request_permission` 与 `terminal/create` 都转成 `acp_permission`
 *   等本人决定（terminal 带"本话题内始终允许"选项）；同一条命令刚在权限请求里被批准过、
 *   或本话题内已始终允许时，终端直接放行并留一条记录——不让本人为同一件事批两次；
 * - 打断：`session/cancel`，会话保留；结束或取消：终止 agent 进程与它开的终端。
 */
import { stat } from "node:fs/promises";
import {
	type AcpConfig,
	type AcpDown,
	type AcpPermissionOption,
	type AcpToolCall,
	type AcpUp,
	gatewayBaseUrl,
	isAllowOption,
	type TaskLogKind,
	type TaskLogPayload,
	TERMINAL_PERMISSION_OPTIONS,
} from "@orgos/protocol";
import type { AdapterRegistry } from "@/acp/adapters";
import { type AcpClient, createAcpClient, STOP_ERROR } from "@/acp/client";
import { explainFailure } from "@/acp/handshake";
import type { TerminalGate } from "@/acp/terminal-bridge";
import type { AcpRequestPermissionParams } from "@/acp/wire";
import { errFields, log } from "@/log";
import { resolveExisting } from "@/workspace";

export type SendUp = (frame: AcpUp) => void;

/** 终端上"本话题内始终允许"那一项的 optionId。 */
const ALLOW_TASK = "allow_task";

function commandOf(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const command = (input as { command?: unknown }).command;
	return typeof command === "string" && command.trim() ? command.trim() : null;
}

/** agent 给的选项里合法的那些（optionId、name、kind 齐全）。 */
function normalizeOptions(
	params: AcpRequestPermissionParams,
): AcpPermissionOption[] {
	return (params.options ?? []).flatMap((o) =>
		o.optionId && o.kind
			? [{ optionId: o.optionId, name: o.name ?? o.optionId, kind: o.kind }]
			: [],
	);
}

export class AcpTaskSession {
	private client: AcpClient | null = null;
	private readonly queue: string[] = [];
	private running = false;
	private disposed = false;
	private permSeq = 0;
	private readonly waiting = new Map<
		string,
		(optionId: string | null) => void
	>();
	/** 在权限请求里刚被批准、还没开终端的命令。 */
	private readonly approvedCommands: string[] = [];
	/** 本话题内命令始终允许。 */
	private terminalAlways = false;

	constructor(
		readonly taskId: string,
		private readonly opts: {
			config: AcpConfig;
			/** 企业模式下另外从子进程环境里去掉的键。 */
			unset: readonly string[];
			/** 设备工作目录与外部助手的工作目录（后者必须在前者之内）。 */
			runnerWorkspace: string;
			workspace: string;
			send: SendUp;
			onGone: () => void;
		},
	) {}

	private emit<K extends TaskLogKind>(kind: K, payload: TaskLogPayload<K>) {
		if (this.disposed && kind !== "error") return;
		this.opts.send({ t: "acp_event", taskId: this.taskId, kind, payload });
	}

	private fatal(message: string): false {
		this.emit("error", { message, fatal: true });
		this.dispose();
		return false;
	}

	/**
	 * 校验工作目录（真实路径须在设备工作目录内）、起进程、握手，成功后发出第一段话。
	 * 失败返回 false（已记致命 error、已收掉进程）。
	 */
	async start(firstPrompt: string): Promise<boolean> {
		let workspace: string;
		try {
			workspace = await resolveExisting(
				this.opts.runnerWorkspace,
				this.opts.workspace,
			);
			if (!(await stat(workspace)).isDirectory())
				return this.fatal(`工作目录不可用：${this.opts.workspace} 不是目录`);
		} catch (e) {
			return this.fatal(
				`工作目录不可用：${e instanceof Error ? e.message : String(e)}`,
			);
		}
		if (this.disposed) return false;
		const client = createAcpClient({
			config: this.opts.config,
			unset: this.opts.unset,
			workspace,
			emit: (kind, payload) => this.emit(kind, payload),
			requestPermission: (params) => this.onAgentPermission(params),
			terminalGate: this.terminalGate,
			onGone: (why) => {
				this.fatal(why);
				this.opts.onGone();
			},
		});
		this.client = client;
		log.info("acp.task_start", { taskId: this.taskId, workspace });
		const state = await client.start();
		if (this.disposed) return false;
		if (state.phase !== "ready") return this.fatal(explainFailure(state));
		this.emit("state", {
			state: "ready",
			...(state.sessionId ? { sessionId: state.sessionId } : {}),
			...(state.agentName ? { agentName: state.agentName } : {}),
			...(state.versionWarning ? { note: state.versionWarning } : {}),
		});
		this.prompt(firstPrompt);
		return true;
	}

	/** 发一段话；上一轮还在进行时排队。 */
	prompt(text: string): void {
		this.queue.push(text);
		void this.pump();
	}

	private async pump(): Promise<void> {
		const client = this.client;
		if (this.running || !client) return;
		this.running = true;
		try {
			for (;;) {
				const text = this.queue.shift();
				if (text === undefined || this.disposed) return;
				const stopReason = await client.prompt(text);
				if (this.disposed) return;
				this.opts.send({
					t: "acp_turn_end",
					taskId: this.taskId,
					stopReason,
					sessionId: client.state().sessionId,
				});
			}
		} catch (e) {
			log.error("acp.pump_failed", errFields(e));
			this.opts.send({
				t: "acp_turn_end",
				taskId: this.taskId,
				stopReason: STOP_ERROR,
				sessionId: client.state().sessionId,
			});
		} finally {
			this.running = false;
		}
	}

	interrupt(): void {
		this.queue.length = 0;
		this.client?.cancel();
	}

	/** 本人对某个权限请求的决定到了。 */
	reply(requestId: string, optionId: string | null): void {
		const resolve = this.waiting.get(requestId);
		if (!resolve) return;
		this.waiting.delete(requestId);
		resolve(optionId);
	}

	private ask(
		toolCall: AcpToolCall,
		options: readonly AcpPermissionOption[],
		source: "agent" | "terminal",
	): Promise<string | null> {
		if (this.disposed) return Promise.resolve(null);
		this.permSeq += 1;
		const requestId = `p${this.permSeq}`;
		return new Promise<string | null>((resolve) => {
			this.waiting.set(requestId, resolve);
			this.opts.send({
				t: "acp_permission",
				taskId: this.taskId,
				requestId,
				toolCall,
				options: [...options],
				source,
			});
		});
	}

	private async onAgentPermission(
		params: AcpRequestPermissionParams,
	): Promise<string | null> {
		const options = normalizeOptions(params);
		if (options.length === 0) {
			log.warn("acp.permission_without_options");
			return null;
		}
		const tc = params.toolCall ?? {};
		const toolCall: AcpToolCall = {
			...(tc.toolCallId ? { toolCallId: tc.toolCallId } : {}),
			title: tc.title ?? tc.kind ?? "工具",
			...(tc.kind ? { kind: tc.kind } : {}),
			...(tc.rawInput === undefined ? {} : { rawInput: tc.rawInput }),
		};
		const optionId = await this.ask(toolCall, options, "agent");
		const chosen = options.find((o) => o.optionId === optionId);
		const command = commandOf(tc.rawInput);
		if (chosen && isAllowOption(chosen) && command) {
			if (chosen.kind === "allow_always") this.terminalAlways = true;
			else this.approvedCommands.push(command);
		}
		return optionId;
	}

	private readonly terminalGate: TerminalGate = async ({ command }) => {
		if (this.terminalAlways) {
			this.emit("permission", {
				title: command,
				auto: "本话题内已始终允许",
				input: { command },
			});
			return { allowed: true };
		}
		const at = this.approvedCommands.indexOf(command.trim());
		if (at >= 0) {
			this.approvedCommands.splice(at, 1);
			this.emit("permission", {
				title: command,
				auto: "已在权限请求中批准",
				input: { command },
			});
			return { allowed: true };
		}
		const optionId = await this.ask(
			{ title: command, kind: "execute", rawInput: { command } },
			TERMINAL_PERMISSION_OPTIONS,
			"terminal",
		);
		const chosen = TERMINAL_PERMISSION_OPTIONS.find(
			(o) => o.optionId === optionId,
		);
		if (!chosen || !isAllowOption(chosen))
			return { allowed: false, reason: "本人拒绝执行这条命令" };
		if (chosen.optionId === ALLOW_TASK) this.terminalAlways = true;
		return { allowed: true };
	};

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.queue.length = 0;
		for (const resolve of this.waiting.values()) resolve(null);
		this.waiting.clear();
		this.client?.dispose();
	}
}

/**
 * 本机全部外部 agent 会话：按会话槽处理服务端下发的 acp_* 帧。
 * 会话在收到 acp_start 时同步登记（重连的 hello 据此上报在跑的会话槽）。
 */
export class AcpManager {
	private readonly sessions = new Map<string, AcpTaskSession>();

	constructor(
		private readonly deps: {
			/** 设备工作目录（外部助手的工作目录必须在它之内）。 */
			runnerWorkspace: string;
			/** Runner 连的服务端：企业模式下 agent 的网关地址由它得出。 */
			server: string;
			adapters: AdapterRegistry;
			send: SendUp;
		},
	) {}

	/** 仍在运行的会话槽。 */
	running(): string[] {
		return [...this.sessions.keys()];
	}

	handle(frame: AcpDown): void {
		const session = this.sessions.get(frame.taskId);
		switch (frame.t) {
			case "acp_start":
				if (!session) void this.start(frame);
				return;
			case "acp_prompt":
				if (session) session.prompt(frame.prompt);
				else this.lost(frame.taskId);
				return;
			case "acp_permission_reply":
				session?.reply(frame.requestId, frame.optionId);
				return;
			case "acp_interrupt":
				session?.interrupt();
				return;
			case "acp_cancel":
				if (session) {
					this.sessions.delete(frame.taskId);
					session.dispose();
					log.info("acp.task_closed", { taskId: frame.taskId });
				}
				return;
		}
	}

	/** 服务端还以为在跑、本机却没有的会话槽。 */
	private lost(taskId: string): void {
		this.deps.send({
			t: "acp_event",
			taskId,
			kind: "error",
			payload: { message: "设备上没有这个话题的外部助手会话", fatal: true },
		});
	}

	private async start(
		frame: Extract<AcpDown, { t: "acp_start" }>,
	): Promise<void> {
		const launch = this.deps.adapters.launch(
			frame.adapter,
			frame.llm
				? {
						baseUrl: gatewayBaseUrl(this.deps.server),
						token: frame.llm.token,
						model: frame.llm.model,
					}
				: undefined,
		);
		if (!launch.ok) {
			this.deps.send({
				t: "acp_event",
				taskId: frame.taskId,
				kind: "error",
				payload: { message: launch.error, fatal: true },
			});
			return;
		}
		const session = new AcpTaskSession(frame.taskId, {
			config: launch.config,
			unset: launch.unset,
			runnerWorkspace: this.deps.runnerWorkspace,
			workspace: frame.workspace,
			send: this.deps.send,
			onGone: () => this.forget(session),
		});
		// 先登记再做任何异步的事：此刻到来的 hello 要能上报它。
		this.sessions.set(frame.taskId, session);
		if (!(await session.start(frame.prompt))) this.forget(session);
	}

	private forget(session: AcpTaskSession): void {
		if (this.sessions.get(session.taskId) === session)
			this.sessions.delete(session.taskId);
	}

	disposeAll(): void {
		for (const session of this.sessions.values()) session.dispose();
		this.sessions.clear();
	}
}
