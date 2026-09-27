/**
 * ACP 的传输层：NDJSON 分帧 + JSON-RPC 2.0 双向对等体。
 *
 * 纯逻辑，零 IO：写出去经注入的 `write`，读进来经调用方喂 `feed`，可以不起子进程逐条断言。
 *
 * 两条事实：
 *   1. 分帧是 NDJSON——一行一个 JSON-RPC 报文、`\n` 分隔，不是 LSP 那套 `Content-Length`。
 *   2. 是对等的：agent 会反过来请求我们（fs / terminal / 权限），所以这里同时是 client 和 server。
 *
 * 坏行必须留档而不是静默丢：第三方进程往 stdout 里混一行日志是常见事故，
 * "什么都没发生"是最难查的故障形态。解码器把坏行原样交出来，由调用方决定怎么记。
 */

/** JSON-RPC 2.0 报文（ACP 只用到这几个字段）。 */
export interface JsonRpcMessage {
	jsonrpc: "2.0";
	/** 请求/响应有 id；通知没有。 */
	id?: number | string;
	/** 请求与通知有 method；响应没有。 */
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

/** JSON-RPC 2.0 标准错误码（只列我们会发的那几个）。 */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INTERNAL_ERROR = -32603;

/** 解码出来的一行：要么是合法报文，要么是我们看不懂的原文。 */
export type DecodedLine =
	| { ok: true; message: JsonRpcMessage }
	| { ok: false; raw: string; error: string };

/**
 * NDJSON 解码器（有状态：跨 chunk 的半行留在缓冲里）。
 *
 * 空行直接跳过——第三方进程的输出里出现空行不构成任何信息。
 */
export function createNdjsonDecoder(): (chunk: string) => DecodedLine[] {
	let buffer = "";
	return (chunk: string): DecodedLine[] => {
		buffer += chunk;
		const lines = buffer.split("\n");
		// 最后一段可能是半行，留到下一个 chunk。
		buffer = lines.pop() ?? "";
		const out: DecodedLine[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as JsonRpcMessage;
				if (parsed === null || typeof parsed !== "object") {
					out.push({ ok: false, raw: trimmed, error: "not an object" });
					continue;
				}
				out.push({ ok: true, message: parsed });
			} catch (err) {
				out.push({ ok: false, raw: trimmed, error: (err as Error).message });
			}
		}
		return out;
	};
}

/** 编码一帧（含结尾换行——分帧符是报文的一部分，别让调用方自己记得加）。 */
export function encodeFrame(message: JsonRpcMessage): string {
	return `${JSON.stringify(message)}\n`;
}

/** 报文分类（纯函数；对等体的分发与它的单测都按这个判据走）。 */
export type MessageKind = "request" | "notification" | "response" | "invalid";

/**
 * 判一条报文是什么。
 *
 * 判据顺序即语义：**有 method 就是入站调用**（带 id 是请求、不带是通知），
 * 没 method 但有 id 才是对我们此前请求的响应。既没 method 又没 id 的报文无处可归。
 */
export function classify(message: JsonRpcMessage): MessageKind {
	if (typeof message.method === "string") {
		return message.id === undefined || message.id === null
			? "notification"
			: "request";
	}
	if (message.id === undefined || message.id === null) return "invalid";
	return "response";
}

/** 入站请求/通知的处理器。抛错即回一条 JSON-RPC error（通知则只留日志）。 */
export type InboundHandler = (
	method: string,
	params: unknown,
) => Promise<unknown>;

export interface JsonRpcPeerDeps {
	/** 把一帧写出去（已含换行）。 */
	write: (frame: string) => void;
	/** 处理 agent 反向发来的请求与通知。 */
	handle: InboundHandler;
	/** 收到看不懂的行 / 处理入站失败时的留档口（不接就是丢掉，故调用方一定要接）。 */
	onProblem?: (what: string, detail: Record<string, unknown>) => void;
}

export interface JsonRpcPeer {
	/** 发一条请求，promise 在对方响应时落定（error 响应 → reject）。 */
	request(method: string, params?: unknown): Promise<unknown>;
	/** 发一条通知（没有响应，不进 pending 表）。 */
	notify(method: string, params?: unknown): void;
	/** 喂一个 stdout chunk（内部做 NDJSON 分帧 + 分发）。 */
	feed(chunk: string): void;
	/** 当前还挂着几条出站请求（诊断与测试）。 */
	pendingCount(): number;
	/**
	 * 作废全部挂起请求。**子进程一死就必须调它**——否则 `await` 在响应上的每一条
	 * 调用链都会永远悬着（会话看起来"卡住"而没有任何错误）。
	 */
	rejectAll(reason: Error): void;
}

/**
 * JSON-RPC 错误 → Error（把 code/data 一起带进 message，排障时才有实据）。
 */
export function rpcErrorToError(err: JsonRpcError): Error {
	const detail = err.data === undefined ? "" : ` ${JSON.stringify(err.data)}`;
	return new Error(`[${err.code}] ${err.message}${detail}`);
}

export function createJsonRpcPeer(deps: JsonRpcPeerDeps): JsonRpcPeer {
	const { write, handle } = deps;
	const problem =
		deps.onProblem ??
		((): void => {
			/* 调用方没接就是明确选择不留档 */
		});
	const decode = createNdjsonDecoder();
	const pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	let nextId = 1;
	let closed = false;

	/** 应答一条入站请求（成功或失败），失败一律回标准 error 对象。 */
	const respond = async (
		id: number | string,
		method: string,
		params: unknown,
	) => {
		try {
			const result = await handle(method, params);
			write(encodeFrame({ jsonrpc: "2.0", id, result: result ?? {} }));
		} catch (err) {
			problem("inbound_failed", { method, error: (err as Error).message });
			write(
				encodeFrame({
					jsonrpc: "2.0",
					id,
					error: {
						code: JSON_RPC_INTERNAL_ERROR,
						message: (err as Error).message,
					},
				}),
			);
		}
	};

	return {
		request(method, params) {
			if (closed) {
				return Promise.reject(new Error(`acp peer closed (${method})`));
			}
			const id = nextId++;
			return new Promise<unknown>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
			});
		},

		notify(method, params) {
			if (closed) return;
			write(encodeFrame({ jsonrpc: "2.0", method, params }));
		},

		feed(chunk) {
			for (const line of decode(chunk)) {
				if (!line.ok) {
					// 第三方进程往 stdout 混了非协议内容。不是致命错误（很多 CLI 会打横幅），
					// 但必须留档——静默丢弃会让"它怎么没反应"查无实据。
					problem("bad_line", {
						raw: line.raw.slice(0, 400),
						error: line.error,
					});
					continue;
				}
				const msg = line.message;
				switch (classify(msg)) {
					case "request":
						void respond(
							msg.id as number | string,
							msg.method as string,
							msg.params,
						);
						break;
					case "notification":
						void handle(msg.method as string, msg.params).catch((err) => {
							problem("inbound_notification_failed", {
								method: msg.method,
								error: (err as Error).message,
							});
						});
						break;
					case "response": {
						const id = msg.id;
						const waiter = typeof id === "number" ? pending.get(id) : undefined;
						if (!waiter) {
							// 对不上号的响应：对方回了一条我们没发过（或已作废）的请求。
							problem("orphan_response", { id: String(id) });
							break;
						}
						pending.delete(id as number);
						if (msg.error) waiter.reject(rpcErrorToError(msg.error));
						else waiter.resolve(msg.result);
						break;
					}
					case "invalid":
						problem("invalid_message", {
							raw: JSON.stringify(msg).slice(0, 400),
						});
						break;
				}
			}
		},

		pendingCount: () => pending.size,

		rejectAll(reason) {
			closed = true;
			for (const waiter of pending.values()) waiter.reject(reason);
			pending.clear();
		},
	};
}
