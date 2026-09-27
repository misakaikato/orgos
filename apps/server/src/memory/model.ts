/**
 * 记忆层的模型调用：用租户默认模型经网关（与代理引擎同一个客户端，MOCK_LLM=1 时为假模型），
 * 每次调用先开一个系统运行，计量挂在它名下，调用结束即结束该运行。
 */
import type { ChatMessage, LlmClient, RunTrigger } from "@/agent/llm-types";
import type { Scoped } from "@/db/scope";
import { finishRun, startSystemRun } from "@/services/runs";
import { getTenantSettings } from "@/services/tenant-settings";

export type SystemCall = {
	s: Scoped;
	llm: LlmClient;
	purpose: NonNullable<RunTrigger["memory"]>;
	/** 运行记录里的触发来源，如 `memory_job:<id>`、`memory_profile:<subjectId>`。 */
	trigger: string;
	place?: { conversationId: string; topicId: string };
	system: string;
	user: string;
};

/** 调一次模型，返回文本与所属的系统运行。失败抛出（由作业执行器记错与重试）。 */
export async function callSystemModel(
	call: SystemCall,
): Promise<{ text: string; runId: string }> {
	const { s } = call;
	const runId = await startSystemRun(s, {
		...(call.place ?? {}),
		trigger: call.trigger,
	});
	const messages: ChatMessage[] = [
		{ role: "system", content: call.system },
		{ role: "user", content: call.user },
	];
	try {
		const { defaultModel } = await getTenantSettings(s);
		const res = await call.llm.complete({
			messages,
			tools: [],
			json: true,
			meta: {
				tenantId: s.tenantId,
				agentId: null,
				onBehalfOfId: null,
				conversationId: call.place?.conversationId ?? null,
				runId,
				taskId: null,
				model: defaultModel,
			},
			trigger: {
				text: "",
				mentions: [],
				agent: { id: "system", handle: "system" },
				conversationKind: "dm",
				memory: call.purpose,
			},
		});
		await finishRun(s, runId, {
			state: "completed",
			summary: call.purpose === "extract" ? "记忆提炼" : "画像整理",
		});
		return { text: res.text, runId };
	} catch (e) {
		await finishRun(s, runId, {
			state: "failed",
			summary: e instanceof Error ? e.message : String(e),
		});
		throw e;
	}
}
