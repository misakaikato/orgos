/**
 * 基础工具：pass、knowledge_search、memory_save、create_commitment。
 */
import { z } from "zod";
import { forOwner, makeTool } from "@/agent/tools/tool";
import { createNote, searchNotes } from "@/services/notes";
import { createWorkItem, notifyWorkItem } from "@/services/work-items";

export const passTool = makeTool({
	name: "pass",
	description:
		"群聊里这条消息不需要你回应时调用：无声跳过，不发任何消息。调用后不要再输出文字。",
	label: "",
	schema: z.object({}),
	available: (scope) => scope.conversation.kind === "group",
	run: async () => ({ result: "", summary: "跳过", ok: true, pass: true }),
});

export const knowledgeSearchTool = makeTool({
	name: "knowledge_search",
	description:
		"检索本人的资料与记忆。query 用几个关键词，空格分隔。返回每行一条“标题：正文”，没有命中时返回“无结果”。",
	label: "正在查资料…",
	schema: z.object({ query: z.string().trim().min(1).max(200) }),
	available: () => true,
	run: async ({ query }, scope) => {
		const rows = await searchNotes(scope.s, scope.owner.id, query, {
			sharedOnly: !forOwner(scope),
		});
		const titles = rows.map((r) => `《${r.title}》`).join("");
		return {
			result:
				rows.length === 0
					? "无结果"
					: rows.map((r) => `${r.title}：${r.body}`).join("\n"),
			summary:
				rows.length === 0 ? `查资料“${query}”：无结果` : `查阅了${titles}`,
			ok: true,
		};
	},
});

export const memorySaveTool = makeTool({
	name: "memory_save",
	description:
		"把值得以后记住的事记进本人的私有记忆（只有本人和替本人办事的代理能看到）。",
	label: "正在记下…",
	schema: z.object({
		title: z.string().trim().min(1).max(120),
		body: z.string().trim().max(8000),
	}),
	available: forOwner,
	run: async ({ title, body }, scope) => {
		await createNote(scope.s, {
			ownerId: scope.owner.id,
			authorId: scope.agent.principal.id,
			title,
			body,
			visibility: "private",
		});
		return {
			result: `已记下《${title}》`,
			summary: `记下了《${title}》`,
			ok: true,
		};
	},
});

export const createCommitmentTool = makeTool({
	name: "create_commitment",
	description:
		"给本人建一条承诺待办（本人需要去做的事），dueAt 为可选的截止时间（ISO 8601，带时区）。",
	label: "正在建待办…",
	schema: z.object({
		title: z.string().trim().min(1).max(120),
		dueAt: z.iso.datetime({ offset: true }).optional(),
	}),
	available: () => true,
	run: async ({ title, dueAt }, scope) => {
		const requesterId =
			scope.actingFor.kind === "other"
				? scope.actingFor.principalId
				: scope.owner.id;
		const item = await createWorkItem(scope.s, {
			kind: "commitment",
			payload: {},
			title,
			body: `${scope.agent.principal.displayName}记下的承诺`,
			ownerId: scope.owner.id,
			requesterId,
			conversationId: scope.conversation.id,
			dueAt: dueAt ? new Date(dueAt) : null,
		});
		notifyWorkItem(item);
		return {
			result: `已给${scope.owner.displayName}建待办：${title}`,
			summary: `建了待办“${title}”`,
			ok: true,
		};
	},
});
