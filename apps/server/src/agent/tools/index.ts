/**
 * 代理工具表：唯一的注册处。本阶段注册 pass、memory_search、memory_save、record_decision（单元分身）、
 * delegate_to_teammate、escalate_to_owner、create_commitment、negotiate、negotiation_reply、post_html，
 * 设备的 device_list / device_read / device_write / device_exec，以及应用接口的 app_api_search / app_api_call。
 */
import type { ToolSpec } from "@/agent/llm-types";
import { appApiCallTool, appApiSearchTool } from "@/agent/tools/app-api";
import {
	createCommitmentTool,
	memorySaveTool,
	memorySearchTool,
	passTool,
	recordDecisionTool,
} from "@/agent/tools/builtin";
import { delegateTool } from "@/agent/tools/delegate";
import {
	deviceExecTool,
	deviceListTool,
	deviceReadTool,
	deviceWriteTool,
} from "@/agent/tools/device";
import { escalateTool } from "@/agent/tools/escalate";
import { negotiateTool, negotiationReplyTool } from "@/agent/tools/negotiate";
import { postHtmlTool } from "@/agent/tools/post-html";
import type { AgentTool, ToolOutcome, ToolScope } from "@/agent/tools/tool";

export const TOOLS: readonly AgentTool[] = [
	passTool,
	memorySearchTool,
	memorySaveTool,
	recordDecisionTool,
	delegateTool,
	escalateTool,
	createCommitmentTool,
	negotiateTool,
	negotiationReplyTool,
	postHtmlTool,
	deviceListTool,
	deviceReadTool,
	deviceWriteTool,
	deviceExecTool,
	appApiSearchTool,
	appApiCallTool,
];

/** 本次运行可用的工具（不可用的不出现在给模型的列表里）。 */
export function availableTools(scope: ToolScope): AgentTool[] {
	return TOOLS.filter((t) => t.available(scope));
}

export function toToolSpec(tool: AgentTool): ToolSpec {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}

/** 执行时状态行的灰字；空串表示不显示（pass 无声）。未注册的工具按执行命令显示。 */
export function toolLabel(name: string): string {
	return TOOLS.find((t) => t.name === name)?.label ?? "正在执行命令…";
}

function parseArgs(raw: string): unknown {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * 执行模型的一次工具调用。工具不存在或本次不可用 → "无权限"（即便模型编造调用）。
 */
export async function executeToolCall(
	call: { name: string; arguments: string },
	scope: ToolScope,
): Promise<ToolOutcome> {
	const tool = TOOLS.find((t) => t.name === call.name);
	if (!tool?.available(scope)) {
		return {
			result: `无权限：当前不能使用 ${call.name}`,
			summary: `尝试使用 ${call.name}：无权限`,
			ok: false,
		};
	}
	const args = parseArgs(call.arguments);
	if (args === undefined) {
		return {
			result: "参数不是合法 JSON",
			summary: `调用 ${call.name} 的参数不合法`,
			ok: false,
		};
	}
	try {
		return await tool.execute(args, scope);
	} catch (e) {
		console.error(`[agent] 工具 ${call.name} 执行出错`, e);
		return {
			result: `工具执行出错：${e instanceof Error ? e.message : String(e)}`,
			summary: `${call.name} 执行出错`,
			ok: false,
		};
	}
}
