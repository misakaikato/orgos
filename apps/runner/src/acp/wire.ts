/**
 * ACP 报文体的 TS 形态（只有类型，没有运行期代码）。
 *
 * 字段照 `@agentclientprotocol/sdk` 的 `schema/schema.json` 抄，只抄我们真的会读的那些；
 * 不引 SDK 包：线格式是 NDJSON，复杂度不在编解码，schema 本身才是真相源。
 *
 * 一切字段按可能缺席对待：这是第三方进程发过来的东西，少一个字段就崩掉的翻译器
 * 会把"对方版本略新"变成"任务整个挂掉"。
 */

// ─────────────────────────── 能力协商 ───────────────────────────

/** 我们（Client）声明的能力：Runner 能替 agent 做什么。 */
export interface AcpClientCapabilities {
	fs: { readTextFile: boolean; writeTextFile: boolean };
	terminal: boolean;
}

/** agent 在 `initialize` 里报回来的能力（只列我们会看的）。 */
export interface AcpAgentCapabilities {
	loadSession?: boolean;
	promptCapabilities?: {
		image?: boolean;
		audio?: boolean;
		embeddedContext?: boolean;
	};
}

export interface AcpImplementation {
	name?: string;
	title?: string;
	version?: string;
}

/** agent 支持的登录方式。**非空 = 它需要用户自己的凭据**（BYOK 的协议级依据）。 */
export interface AcpAuthMethod {
	id: string;
	name?: string;
	description?: string | null;
}

export interface AcpInitializeResponse {
	protocolVersion?: number;
	agentCapabilities?: AcpAgentCapabilities;
	agentInfo?: AcpImplementation | null;
	authMethods?: AcpAuthMethod[];
}

export interface AcpNewSessionResponse {
	sessionId?: string;
}

// ─────────────────────────── 内容块 ───────────────────────────

/**
 * ACP `ContentBlock`。我们只发 `text`；读到其他类型时降级成一句说明，形状留全。
 */
export interface AcpContentBlock {
	type?: string;
	text?: string;
	/** type==="image" 时的 base64 与 mime。 */
	data?: string;
	mimeType?: string;
	/** type==="resource_link" 时的目标。 */
	uri?: string;
	name?: string;
}

// ─────────────────────────── session/update 的 11 个档位 ───────────────────────────

export type AcpToolCallStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "failed";

/** ACP `ToolCallContent` 的三型（content / diff / terminal）。 */
export interface AcpToolCallContent {
	type?: string;
	content?: AcpContentBlock;
	/** type==="diff" 时。 */
	path?: string;
	oldText?: string | null;
	newText?: string;
	/** type==="terminal" 时。 */
	terminalId?: string;
}

export interface AcpToolCallFields {
	toolCallId?: string;
	title?: string | null;
	kind?: string | null;
	status?: AcpToolCallStatus | null;
	content?: AcpToolCallContent[] | null;
	rawInput?: unknown;
	rawOutput?: unknown;
	locations?: { path?: string; line?: number | null }[] | null;
}

export interface AcpPlanEntry {
	content?: string;
	priority?: string;
	status?: string;
}

/**
 * `session/update` 通知的 `update` 体：11 个档位的**可选字段并集**，
 * 判别式是 `sessionUpdate`，翻译器按它 switch。
 *
 * `content` 一个名字两种形状，这是 ACP 自己的形态、不是我们抄错了：
 *   - `*_chunk` 三档（ContentChunk）：**单个** `ContentBlock`；
 *   - `tool_call` / `tool_call_update`（ToolCall）：`ToolCallContent[]`。
 * 翻译器必须按档位分别取，混着读会在工具卡上渲染出 `[object Object]`。
 */
export interface AcpSessionUpdate extends Omit<AcpToolCallFields, "content"> {
	sessionUpdate?: string;
	content?: AcpContentBlock | AcpToolCallContent[] | null;
	/** plan 档携带。 */
	entries?: AcpPlanEntry[];
	/** usage_update 携带。 */
	used?: number;
	size?: number;
	/** current_mode_update 携带。 */
	currentModeId?: string;
}

/** `session/update` 的完整 params。 */
export interface AcpSessionNotification {
	sessionId?: string;
	update?: unknown;
}

// ─────────────────────────── client 侧入站请求 ───────────────────────────

export interface AcpReadTextFileParams {
	sessionId?: string;
	path?: string;
	line?: number | null;
	limit?: number | null;
}

export interface AcpWriteTextFileParams {
	sessionId?: string;
	path?: string;
	content?: string;
}

export interface AcpEnvVariable {
	name?: string;
	value?: string;
}

export interface AcpCreateTerminalParams {
	sessionId?: string;
	command?: string;
	args?: string[];
	cwd?: string | null;
	env?: AcpEnvVariable[];
	outputByteLimit?: number | null;
}

export interface AcpTerminalRefParams {
	sessionId?: string;
	terminalId?: string;
}

export interface AcpPermissionOption {
	optionId?: string;
	name?: string;
	/** `allow_once` | `allow_always` | `reject_once` | `reject_always`。 */
	kind?: string;
}

export interface AcpRequestPermissionParams {
	sessionId?: string;
	toolCall?: AcpToolCallFields;
	options?: AcpPermissionOption[];
}

// ─────────────────────────── 出站响应 ───────────────────────────

export interface AcpPromptResponse {
	stopReason?: string;
}
