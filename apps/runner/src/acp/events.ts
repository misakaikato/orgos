/**
 * ACP `session/update` → 任务过程记录（task_logs 的 kind 与载荷）的翻译表。
 *
 * 纯函数式：给定一个更新，产出零到多条记录，只持有"哪些工具调用已经记过开头"这一点状态。
 * 翻不出来的档位只留 Runner 日志，不编造记录。
 *
 * 最容易翻错的三处：
 *   1. `*_chunk` 的 `content` 是单个 ContentBlock，`tool_call*` 的是数组（见 wire.ts）。
 *   2. `tool_call` 与 `tool_call_update` 是同一次调用的多条消息（先声明后更新）：按 `status` 判，
 *      `completed` / `failed` 才是结果，`pending` / `in_progress` 只是开头。
 *   3. 同一个 `toolCallId` 可能来多条 update：开头每个 id 只记一次。
 */
import path from "node:path";
import type { TaskLogKind, TaskLogPayload } from "@orgos/protocol";
import type { TaskTranscript } from "@/acp/history";
import type {
	AcpContentBlock,
	AcpSessionUpdate,
	AcpToolCallContent,
} from "@/acp/wire";
import { log } from "@/log";

/** 一条工具结果记录的输出上限（字符）。 */
export const TOOL_OUTPUT_MAX_CHARS = 8_000;

export type EmitLog = <K extends TaskLogKind>(
	kind: K,
	payload: TaskLogPayload<K>,
) => void;

/** 取一个 ContentBlock 的可读文本（非 text 档降级成一句说明）。 */
export function contentBlockText(block: AcpContentBlock | undefined): string {
	if (!block) return "";
	if (block.type === "text" || block.type === undefined)
		return block.text ?? "";
	if (block.type === "image") return `[图片 ${block.mimeType ?? "image"}]`;
	if (block.type === "audio") return `[音频 ${block.mimeType ?? "audio"}]`;
	if (block.type === "resource_link")
		return `[资源 ${block.name ?? block.uri ?? ""}]`;
	if (block.type === "resource") return `[嵌入资源 ${block.uri ?? ""}]`;
	return block.text ?? "";
}

/** 把 `ToolCallContent[]` 压成一段可读输出；diff 档写明改了哪个文件、改成什么样。 */
export function toolContentText(
	content: AcpToolCallContent[] | null | undefined,
): string {
	if (!content || content.length === 0) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (item.type === "diff") {
			parts.push(`--- ${item.path ?? ""}\n${item.newText ?? ""}`);
		} else if (item.type === "terminal") {
			parts.push(`[终端 ${item.terminalId ?? ""}]`);
		} else {
			parts.push(contentBlockText(item.content));
		}
	}
	return parts.filter(Boolean).join("\n");
}

/** plan 档 → 一段人话。 */
export function planText(update: AcpSessionUpdate): string {
	const lines = (update.entries ?? []).map((e) => {
		const mark =
			e.status === "completed"
				? "[x]"
				: e.status === "in_progress"
					? "[~]"
					: "[ ]";
		return `${mark} ${e.content ?? ""}`;
	});
	return lines.length > 0 ? `计划：\n${lines.join("\n")}` : "";
}

function clipText(text: string, max = TOOL_OUTPUT_MAX_CHARS): string {
	return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
}

/** 工作目录内的相对路径；在工作目录外（或不是路径）返回 undefined。 */
export function relativeInside(
	workspace: string,
	p: string | undefined,
): string | undefined {
	if (!p) return undefined;
	const rel = path.relative(workspace, path.resolve(workspace, p));
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
		? rel
		: undefined;
}

export interface AcpEventHandlerDeps {
	emit: EmitLog;
	transcript: TaskTranscript;
	/** 任务的工作目录：diff 里的路径据此转成相对路径（产出列表用）。 */
	workspace: string;
}

export function createAcpEventHandler(
	deps: AcpEventHandlerDeps,
): (update: AcpSessionUpdate) => void {
	const { emit, transcript, workspace } = deps;
	/** 已记过开头的调用 → 它的标题（后续 update 常不再带 title）。 */
	const started = new Map<string, string>();

	const onToolCall = (update: AcpSessionUpdate): void => {
		const id = update.toolCallId ?? "";
		if (!id) {
			log.warn("acp.tool_call_without_id", { status: update.status ?? null });
			return;
		}
		const content = Array.isArray(update.content) ? update.content : null;
		const status = update.status ?? "pending";
		const title = update.title ?? started.get(id) ?? update.kind ?? "工具";
		if (!started.has(id)) {
			started.set(id, title);
			transcript.flush();
			emit("tool_call", {
				toolCallId: id,
				title,
				...(update.kind ? { kind: update.kind } : {}),
				...(update.rawInput === undefined ? {} : { input: update.rawInput }),
			});
		}
		if (status !== "completed" && status !== "failed") return;
		const raw =
			update.rawOutput !== undefined && update.rawOutput !== null
				? typeof update.rawOutput === "string"
					? update.rawOutput
					: JSON.stringify(update.rawOutput)
				: toolContentText(content);
		const diff = content?.find((c) => c.type === "diff");
		const changed = relativeInside(workspace, diff?.path);
		emit("tool_result", {
			toolCallId: id,
			title,
			ok: status === "completed",
			...(raw ? { output: clipText(raw) } : {}),
			...(changed ? { path: changed } : {}),
		});
		started.delete(id);
	};

	return (update: AcpSessionUpdate): void => {
		const kind = update.sessionUpdate;
		switch (kind) {
			case "agent_message_chunk":
				transcript.text(contentBlockText(update.content as AcpContentBlock));
				break;
			// 思考过程与用户消息回显不进任务记录：前者是 agent 的内部推理，后者是我们刚发过去的话。
			case "agent_thought_chunk":
			case "user_message_chunk":
				break;
			case "tool_call":
			case "tool_call_update":
				onToolCall(update);
				break;
			case "plan": {
				const text = planText(update);
				if (text) {
					transcript.flush();
					emit("agent_text", { text });
				}
				break;
			}
			case "current_mode_update":
				if (update.currentModeId) {
					transcript.flush();
					emit("state", {
						state: "mode",
						note: `切换到 ${update.currentModeId} 模式`,
					});
				}
				break;
			case "usage_update":
			case "available_commands_update":
			case "config_option_update":
			case "session_info_update":
				log.debug("acp.update_unmapped", { kind });
				break;
			default:
				log.warn("acp.update_unknown", { kind: kind ?? null });
				break;
		}
	};
}
