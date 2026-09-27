/**
 * 外部助手经 ACP（Agent Client Protocol，Zed 主导的开放协议：stdio 上的 NDJSON + JSON-RPC 2.0）接入。
 * orgos 的设备 Runner 扮演 Client：提供受限的 fs 与 terminal，第三方 agent 进程扮演 Agent。
 *
 * 本文件放服务端、Runner、前端都要认的部分：
 *   - 协议常量与方法名（字面量的唯一出处）；
 *   - 内置适配器表 `ACP_ADAPTERS`（只在这里定义一次）；
 *   - 启动配置 `AcpConfig` 与入库前 / 启动前共用的卫生判据 `enforceAcpConfig`；
 *   - 子进程环境清洗：`SCRUBBED_ENV_KEYS` 与 `scrubEnvWrap`；
 *   - 权限请求在 Runner 帧、审批待办与界面之间流转的形态。
 *
 * JSON-RPC 编解码、握手状态机、事件翻译只有 Runner 用，住在 `apps/runner/src/acp/`。
 */
import { z } from "zod";

// ─────────────────────────── 协议常量 ───────────────────────────

/** 我们作为 Client 声明支持的 ACP 协议版本；agent 报回的版本如实读回，不一致时记一条说明继续。 */
export const ACP_PROTOCOL_VERSION = 1;

/** agent 侧方法（我们发出去的）。 */
export const ACP_AGENT_METHODS = {
	initialize: "initialize",
	authenticate: "authenticate",
	newSession: "session/new",
	prompt: "session/prompt",
	cancel: "session/cancel",
} as const;

/** client 侧方法（agent 反向调我们的）。 */
export const ACP_CLIENT_METHODS = {
	readTextFile: "fs/read_text_file",
	writeTextFile: "fs/write_text_file",
	requestPermission: "session/request_permission",
	sessionUpdate: "session/update",
	terminalCreate: "terminal/create",
	terminalOutput: "terminal/output",
	terminalWaitForExit: "terminal/wait_for_exit",
	terminalKill: "terminal/kill",
	terminalRelease: "terminal/release",
} as const;

/** `session/prompt` 的停止原因。`error` 是 orgos 自己的：这一轮没能正常结束（会话仍在）。 */
export const ACP_STOP_REASONS = [
	"end_turn",
	"max_tokens",
	"max_turn_requests",
	"refusal",
	"cancelled",
] as const;

// ─────────────────────────── 启动配置与卫生判据 ───────────────────────────

/**
 * 第三方子进程环境里一律剔除的键：Runner 的身份凭据与它连的服务端地址。
 * 三者任何一个落进第三方代码手里，都等于它能冒充这台设备去连 orgos。
 */
export const SCRUBBED_ENV_KEYS = [
	"ORGOS_RUNNER_TOKEN",
	"ORGOS_SERVER_URL",
	"ORGOS_RUNNER_HOME",
] as const;

/** 清洗包装用的 `env`。写绝对路径：不依赖子进程的 PATH。 */
export const ENV_BIN = "/usr/bin/env";

/** 可执行命令：路径或裸命令名，只允许 `[A-Za-z0-9._/-]`（没有空格，无法夹带第二条命令）。 */
export const SPAWN_COMMAND_RE = /^[A-Za-z0-9._/-]+$/;
/** env 变量名（POSIX 惯例）。 */
export const SPAWN_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** env 值里的插值写法：被调用方按自己的环境展开，会绕过 `env -u` 的清洗。 */
export const SPAWN_ENV_VALUE_FORBIDDEN = /\$\{|\$env:|\{env:/;

/** 是否含控制字符（含 NUL 与换行）：它们在命令行参数与 env 里没有正当用途。 */
export function hasControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

export function isValidSpawnCommand(cmd: string, maxLen: number): boolean {
	return cmd.length > 0 && cmd.length <= maxLen && SPAWN_COMMAND_RE.test(cmd);
}

export function isValidSpawnArg(arg: string, maxLen: number): boolean {
	return arg.length <= maxLen && !hasControlChar(arg);
}

export function isValidSpawnEnvValue(value: string, maxLen: number): boolean {
	return (
		value.length <= maxLen &&
		!value.startsWith("!") &&
		!SPAWN_ENV_VALUE_FORBIDDEN.test(value) &&
		!hasControlChar(value)
	);
}

/** env 键：POSIX 命名，且不是被清洗的键（换个途径送回去等于没清洗）。 */
export function isValidSpawnEnvKey(key: string): boolean {
	return (
		SPAWN_ENV_KEY_RE.test(key) &&
		!(SCRUBBED_ENV_KEYS as readonly string[]).includes(key)
	);
}

/**
 * 把一条启动命令包一层 env 清洗：`/usr/bin/env -u K … <command> <args…>`。
 * 不经 shell（`env` 本身是 command，真实命令是它的参数），注入面为零；
 * 清洗出现在进程的命令行上，`ps` 看得见。
 */
export function scrubEnvWrap(
	command: string,
	args: readonly string[],
	/** 另外要去掉的键（企业模式下设备主人自己的凭据等）。 */
	alsoUnset: readonly string[] = [],
): { command: string; args: string[] } {
	return {
		command: ENV_BIN,
		args: [
			...[...SCRUBBED_ENV_KEYS, ...alsoUnset].flatMap((k) => ["-u", k]),
			command,
			...args,
		],
	};
}

export const ACP_COMMAND_MAX = 200;
export const ACP_ARG_MAX = 500;
export const ACP_MAX_ARGS = 20;
export const ACP_MAX_ENV_KEYS = 20;
export const ACP_ENV_VALUE_MAX = 4000;

/** 起一个 ACP agent 进程的三件套。`env` 只放适配器自己需要的开关与企业模式的注入；orgos 不注入任何厂商密钥。 */
export const AcpConfigSchema = z.object({
	command: z.string().default(""),
	args: z.array(z.string()).default([]),
	env: z.record(z.string(), z.string()).default({}),
});
export type AcpConfig = z.infer<typeof AcpConfigSchema>;

export const EMPTY_ACP_CONFIG: AcpConfig = { command: "", args: [], env: {} };

export type AcpRejectReason =
	| "invalid_command"
	| "invalid_args"
	| "invalid_env";

export interface AcpCapResult {
	/** 通过校验的配置；被拒时退回空配置。 */
	config: AcpConfig;
	rejection: { reason: AcpRejectReason; detail: string } | null;
}

/**
 * 启动配置的字符白名单与封顶（服务端与 Runner 共用同一份判据）。整体接受或整体拒绝：
 * 一个任务只有一个 agent 进程，参数错了就是起不来。
 */
export function enforceAcpConfig(
	input: AcpConfig | null | undefined,
): AcpCapResult {
	const config: AcpConfig = {
		command: input?.command ?? "",
		args: input?.args ?? [],
		env: input?.env ?? {},
	};
	const reject = (reason: AcpRejectReason, detail: string): AcpCapResult => ({
		config: { ...EMPTY_ACP_CONFIG },
		rejection: { reason, detail },
	});
	if (!isValidSpawnCommand(config.command, ACP_COMMAND_MAX))
		return reject("invalid_command", config.command.slice(0, 80));
	if (config.args.length > ACP_MAX_ARGS)
		return reject("invalid_args", `${config.args.length} > ${ACP_MAX_ARGS}`);
	const badArg = config.args.find((a) => !isValidSpawnArg(a, ACP_ARG_MAX));
	if (badArg !== undefined) return reject("invalid_args", badArg.slice(0, 80));
	const envKeys = Object.keys(config.env);
	if (envKeys.length > ACP_MAX_ENV_KEYS)
		return reject("invalid_env", `${envKeys.length} > ${ACP_MAX_ENV_KEYS}`);
	const badKey = envKeys.find(
		(k) =>
			!isValidSpawnEnvKey(k) ||
			!isValidSpawnEnvValue(config.env[k] ?? "", ACP_ENV_VALUE_MAX),
	);
	if (badKey !== undefined) return reject("invalid_env", badKey);
	return { config, rejection: null };
}

// ─────────────────────────── 适配器表（唯一定义处） ───────────────────────────

export type AcpAdapterDef = {
	id: string;
	/** 界面上的名字。 */
	label: string;
	/** 启动配置；`fixture` 给定时 command 为 Runner 自身的 bun，参数为该文件的绝对路径。 */
	config: AcpConfig;
	/** 仓库内的测试 agent（相对 apps/runner）。 */
	fixture?: string;
	/** 探测时要求 PATH 上存在的可执行文件。 */
	requires: readonly string[];
	/** 仅 `ORGOS_DEV=1` 时提供。 */
	devOnly?: true;
	/** 该适配器是否把 fs 读写与命令执行交还 Runner（从而受工作目录限制与审批约束）。 */
	delegatesTools: boolean;
	/** 选适配器时给本人看的一句说明。 */
	note: string;
	/** 企业模式的注入规则；null 表示该适配器只支持个人模式（原因写在 enterpriseNote）。 */
	enterprise: AcpEnterpriseInjection | null;
	/** 企业模式的说明（不支持时写明原因）。 */
	enterpriseNote: string;
};

/**
 * 企业模式：让外部 agent 经 orgos 网关调用模型，只持有本任务的令牌。只用本次子进程的环境变量
 * 与启动参数，绝不改设备主人的全局配置文件。值里的占位符在 Runner 起进程时替换：
 *   {baseUrl} 网关地址（`<服务端>/llm`），{token} 任务令牌，{model} 外部助手配置的模型引用。
 * 令牌只放进环境变量，不进命令行（`ps` 看得见命令行）。
 */
export type AcpEnterpriseInjection = {
	env: Readonly<Record<string, string>>;
	/** 追加在适配器启动参数之后；不许出现 {token}。 */
	args: readonly string[];
	/** 从子进程环境里去掉的键：设备主人自己的凭据，以及会让 agent 绕开网关的开关。 */
	unset: readonly string[];
};

export type GatewayLaunch = { baseUrl: string; token: string; model: string };

const fill = (template: string, v: GatewayLaunch, allowToken: boolean) => {
	if (!allowToken && template.includes("{token}"))
		throw new Error("任务令牌只能经环境变量注入");
	return template
		.replaceAll("{baseUrl}", v.baseUrl)
		.replaceAll("{token}", v.token)
		.replaceAll("{model}", v.model);
};

/** 按适配器的注入规则装配企业模式的启动配置（不支持企业模式的适配器返回 null）。 */
export function enterpriseLaunchConfig(
	def: Pick<AcpAdapterDef, "enterprise">,
	base: AcpConfig,
	v: GatewayLaunch,
): { config: AcpConfig; unset: string[] } | null {
	const rule = def.enterprise;
	if (!rule) return null;
	const env: Record<string, string> = { ...base.env };
	for (const [k, t] of Object.entries(rule.env)) env[k] = fill(t, v, true);
	return {
		config: {
			command: base.command,
			args: [...base.args, ...rule.args.map((a) => fill(a, v, false))],
			env,
		},
		unset: [...rule.unset],
	};
}

/**
 * 内置适配器。版本钉死；npx 按需拉取，不写入任何 package.json。
 *
 * - claude-code：Zed 维护的 Claude Code 适配器；声明 fs 与 terminal 能力后，它的读写与 Bash
 *   全部经 Runner 执行，写入与命令先经本人审批。用本机 `claude` 的登录。
 * - codex：Zed 维护的 Codex 适配器；用本机 `codex` 的登录。
 * - pi：第三方 `pi-acp`（MIT，svkozak/pi-acp，2025-12 起持续发布）驱动本机 `pi --mode rpc`；
 *   它不做 ACP 的 fs / terminal 委托、也不发权限请求，读写与命令由 pi 在本机直接执行。
 * - hermes：本机 Hermes Agent 自带 `hermes acp` 入口；它只对自判危险的命令发权限请求，
 *   读写与其余命令在本机直接执行。
 */
export const ACP_ADAPTERS: readonly AcpAdapterDef[] = [
	{
		id: "claude-code",
		label: "Claude Code",
		config: {
			command: "npx",
			args: ["-y", "@zed-industries/claude-code-acp@0.16.2"],
			env: {},
		},
		requires: ["npx", "node"],
		delegatesTools: true,
		note: "读写文件与执行命令都经这台设备，限制在工作目录内，写入和命令先问你。",
		enterprise: {
			env: {
				ANTHROPIC_BASE_URL: "{baseUrl}",
				ANTHROPIC_AUTH_TOKEN: "{token}",
				ANTHROPIC_MODEL: "{model}",
				ANTHROPIC_SMALL_FAST_MODEL: "{model}",
				ANTHROPIC_DEFAULT_OPUS_MODEL: "{model}",
				ANTHROPIC_DEFAULT_SONNET_MODEL: "{model}",
				ANTHROPIC_DEFAULT_HAIKU_MODEL: "{model}",
				CLAUDE_CODE_SUBAGENT_MODEL: "{model}",
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			},
			args: [],
			unset: [
				"ANTHROPIC_API_KEY",
				"CLAUDE_CODE_OAUTH_TOKEN",
				"CLAUDE_CODE_USE_BEDROCK",
				"CLAUDE_CODE_USE_VERTEX",
				"CLAUDE_CODE_USE_FOUNDRY",
				"ANTHROPIC_BEDROCK_BASE_URL",
				"ANTHROPIC_VERTEX_BASE_URL",
			],
		},
		enterpriseNote:
			"ANTHROPIC_BASE_URL 指向网关、ANTHROPIC_AUTH_TOKEN 为任务令牌，主模型与各档小模型都设为该助手的模型。",
	},
	{
		id: "codex",
		label: "Codex",
		config: {
			command: "npx",
			args: ["-y", "@zed-industries/codex-acp@0.16.0"],
			env: {},
		},
		requires: ["npx", "node"],
		delegatesTools: true,
		note: "操作前会请你批准。",
		enterprise: {
			env: { ORGOS_LLM_TOKEN: "{token}" },
			args: [
				"-c",
				'model_providers.orgos.name="orgos"',
				"-c",
				'model_providers.orgos.base_url="{baseUrl}/v1"',
				"-c",
				'model_providers.orgos.env_key="ORGOS_LLM_TOKEN"',
				"-c",
				'model_providers.orgos.wire_api="responses"',
				"-c",
				'model_provider="orgos"',
				"-c",
				'model="{model}"',
			],
			unset: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"],
		},
		enterpriseNote:
			"以 -c 参数定义临时厂商 orgos（Responses 协议，base_url 指向网关），令牌经 ORGOS_LLM_TOKEN 传入；不改 ~/.codex/config.toml。",
	},
	{
		id: "pi",
		label: "pi",
		config: { command: "npx", args: ["-y", "pi-acp@0.0.34"], env: {} },
		requires: ["npx", "node", "pi"],
		delegatesTools: false,
		note: "pi 在本机直接读写文件、执行命令，不经工作目录限制，也不会先问你。使用本机 pi 的配置。",
		enterprise: null,
		enterpriseNote:
			"仅支持个人模式：pi-acp 以固定参数启动 pi，pi 只能经 ~/.pi/agent/models.json 定义自定义端点，没有环境变量或参数可指定 base URL。",
	},
	{
		id: "hermes",
		label: "Hermes",
		config: { command: "hermes", args: ["acp"], env: {} },
		requires: ["hermes"],
		delegatesTools: false,
		note: "Hermes 在本机直接读写文件、执行命令，只有它判断为危险的命令才会先问你。使用本机 Hermes 的配置。",
		enterprise: null,
		enterpriseNote:
			"仅支持个人模式：hermes acp 的厂商与模型取自 ~/.hermes/config.yaml，自定义端点的 key 按主机名筛选，环境变量无法可靠地把它指向网关。",
	},
	{
		id: "fake",
		label: "测试助手",
		config: { command: "bun", args: [], env: {} },
		fixture: "test-fixtures/fake-acp-agent.ts",
		requires: [],
		devOnly: true,
		delegatesTools: true,
		note: "仓库内的测试用 ACP agent，只在开发模式下提供。",
		enterprise: {
			env: {
				OPENAI_BASE_URL: "{baseUrl}/v1",
				OPENAI_API_KEY: "{token}",
				OPENAI_MODEL: "{model}",
			},
			args: [],
			unset: [],
		},
		enterpriseNote: "OpenAI 风格的三个环境变量。",
	},
];

export function findAdapter(id: string): AcpAdapterDef | undefined {
	return ACP_ADAPTERS.find((a) => a.id === id);
}

/**
 * 不经 orgos 审批、不限工作目录的适配器（读写与命令不交还 Runner：pi、Hermes）。
 * 默认不可选：须租户 owner 开启 `allowUnsupervisedAdapters`，且本人创建时勾选确认。
 */
export function isUnsupervisedAdapter(
	def: Pick<AcpAdapterDef, "delegatesTools">,
): boolean {
	return !def.delegatesTools;
}

/** Runner 在 hello 里上报的适配器探测结果。 */
export const AcpAdapterStatusSchema = z.object({
	id: z.string().min(1).max(64),
	command: z.string().max(1000),
	available: z.boolean(),
});
export type AcpAdapterStatus = z.infer<typeof AcpAdapterStatusSchema>;

/** 设备能力名：能以 ACP 驱动外部助手。 */
export const AGENT_ACP_CAPABILITY = "agent.acp";

// ─────────────────────────── 权限请求 ───────────────────────────

export const ACP_PERMISSION_KINDS = [
	"allow_once",
	"allow_always",
	"reject_once",
	"reject_always",
] as const;

export const AcpPermissionOptionSchema = z.object({
	optionId: z.string().min(1).max(200),
	name: z.string().max(200),
	kind: z.string().max(40),
});
export type AcpPermissionOption = z.infer<typeof AcpPermissionOptionSchema>;

export function isAllowOption(option: Pick<AcpPermissionOption, "kind">) {
	return option.kind.startsWith("allow");
}

/** 权限请求里的工具调用摘要（界面展示工具与参数用）。 */
export const AcpToolCallSchema = z.object({
	toolCallId: z.string().max(200).optional(),
	title: z.string().max(2000),
	kind: z.string().max(40).optional(),
	rawInput: z.unknown().optional(),
});
export type AcpToolCall = z.infer<typeof AcpToolCallSchema>;

/**
 * 权限请求的来源：agent 的 `session/request_permission`，或 agent 要在设备上开终端执行命令
 * （等同 shell.exec，由 Runner 转成权限请求）。
 */
export const ACP_PERMISSION_SOURCES = ["agent", "terminal"] as const;

/** terminal 审批卡片上的三个选项：允许、本话题内始终允许、拒绝。 */
export const TERMINAL_PERMISSION_OPTIONS: readonly AcpPermissionOption[] = [
	{ optionId: "allow_once", name: "允许", kind: "allow_once" },
	{ optionId: "allow_task", name: "本话题内始终允许", kind: "allow_always" },
	{ optionId: "reject", name: "拒绝", kind: "reject_once" },
];
