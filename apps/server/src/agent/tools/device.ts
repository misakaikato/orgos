/**
 * 设备工具：device_list / device_read / device_write / device_exec，对应设备的四项能力。
 *
 * 只在代理为本人办事、且绑定了本人的设备时可用。参数 schema 直接取自 protocol 的能力定义；
 * 风险为 read 的直接下发，其余先经 `requestApproval` 请本人批准（运行挂起等待，最长 10 分钟），
 * 批准后下发执行，拒绝、过期或被打断则不执行。设备离线立即返回"设备离线"。
 */
import {
	type ApprovalOutcome,
	DEVICE_CAPABILITIES,
	type DeviceCapabilityArgs,
	type DeviceCapabilityName,
	needsApproval,
} from "@orgos/protocol";
import { eq, isNull } from "drizzle-orm";
import { forOwner, makeTool, type ToolScope } from "@/agent/tools/tool";
import { runners } from "@/db/schema";
import type { RunnerRow } from "@/db/scope";
import { OFFLINE_TEXT, runnerHub } from "@/realtime/runner-hub";
import { requestApproval } from "@/services/work-items";

export const DENIED_TEXT = "本人拒绝了这次操作，没有执行";

const OUTCOME_TEXT: Record<Exclude<ApprovalOutcome, "approve">, string> = {
	deny: DENIED_TEXT,
	expired: "审批超时：本人 10 分钟内没有处理，没有执行",
	cancelled: "审批已取消：本人发了新消息或停止了运行，没有执行",
};

const HEAD_CHARS = 60;

function headOf(text: string): string {
	const chars = Array.from(text.trim());
	return `${chars.slice(0, HEAD_CHARS).join("")}${chars.length > HEAD_CHARS ? "…" : ""}`;
}

const deviceAvailable = (scope: ToolScope) =>
	forOwner(scope) && scope.agent.runnerId !== null;

async function boundRunner(scope: ToolScope): Promise<RunnerRow | undefined> {
	const runnerId = scope.agent.runnerId;
	if (!runnerId) return undefined;
	return scope.s.first(
		runners,
		eq(runners.id, runnerId),
		eq(runners.ownerId, scope.owner.id),
		isNull(runners.revokedAt),
	);
}

type Phrase<N extends DeviceCapabilityName> = {
	/** 动作记录里的说法：“列出 src”“执行 `ls`”。 */
	what: (args: DeviceCapabilityArgs<N>) => string;
	/** 审批待办的正文：完整参数。 */
	body?: (args: DeviceCapabilityArgs<N>) => string;
};

const PHRASES: { [N in DeviceCapabilityName]: Phrase<N> } = {
	"fs.list": { what: (a) => `列出 ${a.path || "."}` },
	"fs.read": { what: (a) => `读取 ${a.path}` },
	"fs.write": {
		what: (a) => `写入 ${a.path}`,
		body: (a) => `写入 ${a.path}：\n${a.content}`,
	},
	"shell.exec": {
		what: (a) => `执行 \`${headOf(a.command)}\``,
		body: (a) => a.command,
	},
};

async function runOnDevice<N extends DeviceCapabilityName>(
	scope: ToolScope,
	capability: N,
	args: DeviceCapabilityArgs<N>,
) {
	const phrase: Phrase<N> = PHRASES[capability];
	const what = phrase.what(args);
	const runner = await boundRunner(scope);
	if (!runner) {
		return {
			result: "设备不可用：绑定的设备已被吊销或不存在",
			summary: `${what}：设备不可用`,
			ok: false,
		};
	}
	if (!runnerHub.isOnline(runner.id)) {
		return {
			result: OFFLINE_TEXT,
			summary: `${what}：${OFFLINE_TEXT}`,
			ok: false,
		};
	}
	if (needsApproval(DEVICE_CAPABILITIES[capability].risk)) {
		const { outcome } = await requestApproval(scope.s, {
			agentId: scope.agent.principal.id,
			conversationId: scope.conversation.id,
			topicId: scope.conversation.topicId,
			runId: scope.runId,
			runnerId: runner.id,
			runnerName: runner.name,
			capability,
			args,
			title: `${scope.agent.principal.displayName}想在“${runner.name}”上${DEVICE_CAPABILITIES[capability].label}`,
			body: phrase.body?.(args) ?? what,
			sourceEventId: scope.triggerEventId,
			signal: scope.session.stopSignal,
		});
		if (outcome !== "approve") {
			return {
				result: OUTCOME_TEXT[outcome],
				summary: `${what}：${OUTCOME_TEXT[outcome]}`,
				ok: false,
			};
		}
	}
	const res = await runnerHub.invoke(
		runner.id,
		capability,
		args,
		scope.session.signal,
	);
	if (!res.ok) {
		return {
			result: `出错：${res.output}`,
			summary: `${what}：出错`,
			ok: false,
		};
	}
	if (capability === "shell.exec") {
		return {
			result: `${res.output || "（没有输出）"}\n（退出码 ${res.exitCode ?? 0}）`,
			summary: `${what}：退出码 ${res.exitCode ?? 0}`,
			ok: true,
		};
	}
	return { result: res.output, summary: what, ok: true };
}

const PATH_HINT =
	"路径相对于设备上本人指定的工作目录（用 . 表示工作目录本身），不能访问工作目录之外。";

export const deviceListTool = makeTool({
	name: "device_list",
	description: `列出本人设备上工作目录里某个目录的内容（名称、类型、大小）。${PATH_HINT}`,
	label: "正在查看目录…",
	schema: DEVICE_CAPABILITIES["fs.list"].args,
	available: deviceAvailable,
	run: (args, scope) => runOnDevice(scope, "fs.list", args),
});

export const deviceReadTool = makeTool({
	name: "device_read",
	description: `读取本人设备上工作目录里的一个文本文件。${PATH_HINT}`,
	label: "正在读文件…",
	schema: DEVICE_CAPABILITIES["fs.read"].args,
	available: deviceAvailable,
	run: (args, scope) => runOnDevice(scope, "fs.read", args),
});

export const deviceWriteTool = makeTool({
	name: "device_write",
	description: `在本人设备的工作目录里写入一个文本文件（覆盖同名文件）。${PATH_HINT}需要本人批准：调用后会等本人在审批卡片上处理，被拒绝就不要再重试同一件事。`,
	label: "等你批准后写入文件…",
	schema: DEVICE_CAPABILITIES["fs.write"].args,
	available: deviceAvailable,
	run: (args, scope) => runOnDevice(scope, "fs.write", args),
});

export const deviceExecTool = makeTool({
	name: "device_exec",
	description:
		"在本人设备的工作目录下用 /bin/sh 执行一条命令，返回合并后的输出与退出码（60 秒超时）。需要本人批准：调用后会等本人在审批卡片上处理，被拒绝就不要再重试同一件事。",
	label: "等你批准后执行命令…",
	schema: DEVICE_CAPABILITIES["shell.exec"].args,
	available: deviceAvailable,
	run: (args, scope) => runOnDevice(scope, "shell.exec", args),
});
