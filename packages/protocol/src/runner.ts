/**
 * 设备 Runner：能力定义、Runner WS 帧、共享常量。服务端、Runner、前端共用这一处。
 *
 * 能力声明 `Capability` 是开放结构：name 为字符串，新能力（例如 `agent.acp` 附带 adapters）
 * 以新增可选字段的方式加入，已有字段不变；服务端只对自己认识的能力下发 invoke。
 */
import { z } from "zod";
import {
	ACP_PERMISSION_SOURCES,
	AcpAdapterStatusSchema,
	AcpPermissionOptionSchema,
	AcpToolCallSchema,
} from "./acp";
import { RUNNER_STATUSES, TASK_LOG_KINDS } from "./entities";

export const RUNNER_PROTOCOL_VERSION = 1;

export const CAPABILITY_RISKS = ["read", "write", "exec"] as const;
export type CapabilityRisk = (typeof CAPABILITY_RISKS)[number];

/** 需要本人批准才能执行的风险级别。 */
export function needsApproval(risk: CapabilityRisk): boolean {
	return risk !== "read";
}

/** 设备的四项基础能力：名称、界面上的动词、说明、风险与参数 schema 的唯一定义处。 */
export const DEVICE_CAPABILITIES = {
	"fs.list": {
		label: "列目录",
		description: "列出工作目录内某个目录的内容",
		risk: "read",
		args: z.object({ path: z.string().max(1024) }),
	},
	"fs.read": {
		label: "读文件",
		description: "读取工作目录内的一个文本文件",
		risk: "read",
		args: z.object({ path: z.string().min(1).max(1024) }),
	},
	"fs.write": {
		label: "写入文件",
		description: "在工作目录内写入一个文本文件（覆盖同名文件）",
		risk: "write",
		args: z.object({
			path: z.string().min(1).max(1024),
			content: z.string().max(1024 * 1024),
		}),
	},
	"shell.exec": {
		label: "执行命令",
		description: "在工作目录下用 /bin/sh 执行一条命令",
		risk: "exec",
		args: z.object({ command: z.string().min(1).max(8000) }),
	},
} as const satisfies Record<
	string,
	{ label: string; description: string; risk: CapabilityRisk; args: z.ZodType }
>;

export type DeviceCapabilityName = keyof typeof DEVICE_CAPABILITIES;
export const DEVICE_CAPABILITY_NAMES = Object.keys(
	DEVICE_CAPABILITIES,
) as DeviceCapabilityName[];
export type DeviceCapabilityArgs<N extends DeviceCapabilityName> = z.infer<
	(typeof DEVICE_CAPABILITIES)[N]["args"]
>;

export const CapabilitySchema = z.object({
	name: z.string().min(1).max(64),
	description: z.string().max(500),
	risk: z.enum(CAPABILITY_RISKS),
	/** `agent.acp`：本机各适配器的启动命令与探测结果。 */
	adapters: z.array(AcpAdapterStatusSchema).max(32).optional(),
});
export type Capability = z.infer<typeof CapabilitySchema>;

/** Runner 在 hello 里声明的基础能力。 */
export function deviceCapabilityList(): Capability[] {
	return DEVICE_CAPABILITY_NAMES.map((name) => ({
		name,
		description: DEVICE_CAPABILITIES[name].description,
		risk: DEVICE_CAPABILITIES[name].risk,
	}));
}

/** 服务端等一个 job 结果的最长时间；shell.exec 在 Runner 上同样以此为限杀进程。 */
export const RUNNER_JOB_TIMEOUT_MS = 60_000;
/** 结果输出的上限（字节，UTF-8）。 */
export const RUNNER_OUTPUT_MAX_BYTES = 64 * 1024;
export const OUTPUT_TRUNCATED_NOTE = "\n…（输出超过 64KB，已截断）";

/** 把输出限制在 maxBytes 字节内；截断时在末尾注明。 */
export function truncateOutput(
	text: string,
	maxBytes: number = RUNNER_OUTPUT_MAX_BYTES,
): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= maxBytes) return text;
	const note = new TextEncoder().encode(OUTPUT_TRUNCATED_NOTE).length;
	const head = new TextDecoder()
		.decode(bytes.slice(0, Math.max(0, maxBytes - note)))
		.replace(/\uFFFD+$/, "");
	return `${head}${OUTPUT_TRUNCATED_NOTE}`;
}

/** Runner WS 的关闭码。 */
export const RUNNER_WS_CLOSE = {
	/** 同一设备的新连接顶掉旧连接。 */
	REPLACED: 4001,
	/** 设备已被本人吊销。 */
	REVOKED: 4003,
} as const;

// ─────────────────────────── 帧 ───────────────────────────

/*
 * 外部 agent 的 acp_* 帧以 `taskId` 标识设备上的一个 ACP 会话槽：服务端每个话题开一个槽，
 * 填的是话题 id（一个话题一个 ACP 会话，主线也是）。Runner 只把它当作不透明的会话键。
 */

/** Runner → 服务端。 */
export const RunnerUpSchema = z.discriminatedUnion("t", [
	z.object({
		t: z.literal("hello"),
		protocol: z.number().int(),
		runnerVersion: z.string().max(64),
		os: z.string().max(64),
		hostname: z.string().max(255),
		workspace: z.string().max(4096),
		capabilities: z.array(CapabilitySchema).max(64),
		/** 本机仍在运行的外部 agent 会话槽：服务端据此接回或让它收尾。 */
		acpTasks: z.array(z.uuid()).max(256).optional(),
	}),
	z.object({ t: z.literal("ping") }),
	/** 能力有变化（例如适配器探测完成）：整份替换 hello 里声明的能力。 */
	z.object({
		t: z.literal("capabilities"),
		capabilities: z.array(CapabilitySchema).max(64),
	}),
	z.object({
		t: z.literal("result"),
		jobId: z.string().min(1).max(64),
		ok: z.boolean(),
		output: z.string(),
		exitCode: z.number().int().optional(),
	}),
	/** 外部任务的过程记录（服务端原样追加到 task_logs）。 */
	z.object({
		t: z.literal("acp_event"),
		taskId: z.uuid(),
		kind: z.enum(TASK_LOG_KINDS),
		payload: z.unknown(),
	}),
	/** 外部 agent 请求权限（或要开终端执行命令）：等本人在审批卡片上选一个选项。 */
	z.object({
		t: z.literal("acp_permission"),
		taskId: z.uuid(),
		requestId: z.string().min(1).max(64),
		toolCall: AcpToolCallSchema,
		options: z.array(AcpPermissionOptionSchema).min(1).max(16),
		source: z.enum(ACP_PERMISSION_SOURCES).optional(),
	}),
	/** 外部 agent 结束一轮（ACP stopReason；`error` 表示这一轮没能正常结束）。 */
	z.object({
		t: z.literal("acp_turn_end"),
		taskId: z.uuid(),
		stopReason: z.string().max(64),
		sessionId: z.string().max(200).nullable(),
	}),
]);
export type RunnerUp = z.infer<typeof RunnerUpSchema>;
/** Runner → 服务端：外部任务相关的三种帧。 */
export type AcpUp = Extract<
	RunnerUp,
	{ t: "acp_event" | "acp_permission" | "acp_turn_end" }
>;

/** 服务端 → Runner。 */
export const RunnerDownSchema = z.discriminatedUnion("t", [
	z.object({ t: z.literal("pong") }),
	z.object({
		t: z.literal("invoke"),
		jobId: z.string().min(1).max(64),
		capability: z.enum(
			DEVICE_CAPABILITY_NAMES as [
				DeviceCapabilityName,
				...DeviceCapabilityName[],
			],
		),
		args: z.unknown(),
	}),
	/** 为一个任务起 ACP agent 进程、建会话并发出第一段话。 */
	z.object({
		t: z.literal("acp_start"),
		taskId: z.uuid(),
		adapter: z.string().min(1).max(64),
		workspace: z.string().min(1).max(4096),
		prompt: z.string().min(1),
		/**
		 * 企业模式：本会话的任务令牌与模型引用。Runner 以自己连的服务端地址拼出网关地址，
		 * 按适配器表的注入规则交给 agent 进程；缺省为个人模式（不注入）。
		 */
		llm: z
			.object({
				token: z.string().min(1).max(200),
				model: z.string().min(1).max(300),
			})
			.optional(),
	}),
	/** 同一任务的追问：继续同一 ACP 会话。 */
	z.object({
		t: z.literal("acp_prompt"),
		taskId: z.uuid(),
		prompt: z.string().min(1),
	}),
	/** 本人对权限请求的决定：所选选项原样回给 agent；null 表示取消。 */
	z.object({
		t: z.literal("acp_permission_reply"),
		taskId: z.uuid(),
		requestId: z.string().min(1).max(64),
		optionId: z.string().max(200).nullable(),
	}),
	/** 打断当前一轮（ACP session/cancel），会话保留。 */
	z.object({ t: z.literal("acp_interrupt"), taskId: z.uuid() }),
	/** 任务结束或取消：终止 agent 进程。 */
	z.object({ t: z.literal("acp_cancel"), taskId: z.uuid() }),
]);
export type RunnerDown = z.infer<typeof RunnerDownSchema>;
/** 服务端 → Runner：外部任务相关的帧。 */
export type AcpDown = Extract<
	RunnerDown,
	{
		t:
			| "acp_start"
			| "acp_prompt"
			| "acp_permission_reply"
			| "acp_interrupt"
			| "acp_cancel";
	}
>;

type Parsed<T> = { ok: true; data: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: string): Parsed<T> {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: "不是合法 JSON" };
	}
	const parsed = schema.safeParse(json);
	return parsed.success
		? { ok: true, data: parsed.data }
		: { ok: false, error: parsed.error.message };
}

/** 解析一帧 Runner 上行文本；不抛异常。 */
export function parseRunnerUp(raw: string): Parsed<RunnerUp> {
	return parseWith(RunnerUpSchema, raw);
}

/** 解析一帧服务端下行文本；不抛异常。 */
export function parseRunnerDown(raw: string): Parsed<RunnerDown> {
	return parseWith(RunnerDownSchema, raw);
}

// ─────────────────────────── 实体与配对 ───────────────────────────

export const RunnerSchema = z.object({
	id: z.uuid(),
	ownerId: z.uuid(),
	name: z.string(),
	os: z.string(),
	workspace: z.string().nullable(),
	capabilities: z.array(CapabilitySchema),
	status: z.enum(RUNNER_STATUSES),
	lastSeenAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
	/** 已吊销：推给本人后前端从列表移除。 */
	revoked: z.boolean().optional(),
});
export type Runner = z.infer<typeof RunnerSchema>;

/** 配对码：6 组 4 位，字母表去掉易混的 0/O、1/I/L。 */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PAIRING_CODE_GROUPS = 6;
export const PAIRING_CODE_GROUP_LENGTH = 4;
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** 规范化用户输入的配对码：去空白与连字符、转大写，再按 4 位一组以连字符连接。 */
export function normalizePairingCode(input: string): string {
	const compact = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
	const groups = compact.match(/.{1,4}/g) ?? [];
	return groups.join("-");
}

export const PAIRING_CODE_RE = new RegExp(
	`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_GROUP_LENGTH}}(-[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_GROUP_LENGTH}}){${PAIRING_CODE_GROUPS - 1}}$`,
);

export const DEVICE_NAME_MAX_LENGTH = 40;

/** 在设备上配对与启动 Runner 的两条命令（设备页展示、Runner 用法说明共用）。 */
export function runnerCommands(input: {
	repoDir: string;
	server: string;
	code: string;
	name: string;
	workspace: string;
}): { pair: string; serve: string } {
	const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
	const prefix = `cd ${q(input.repoDir)} && bun run --cwd apps/runner start`;
	return {
		pair: `${prefix} pair ${input.code} --server ${input.server} --name ${q(input.name)}`,
		serve: `${prefix} serve --workspace ${input.workspace}`,
	};
}
