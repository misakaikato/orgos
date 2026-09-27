/**
 * 基础工具：pass、memory_search、memory_save、record_decision、create_commitment。
 */
import { z } from "zod";
import { deciderIn, forOwner, makeTool } from "@/agent/tools/tool";
import { searchMemory } from "@/memory/search";
import { createNote } from "@/services/notes";
import { recordUnitDecision } from "@/services/unit-notes";
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

export const memorySearchTool = makeTool({
	name: "memory_search",
	description:
		"检索记忆与资料（组织里沉淀下来的事实、进展、决定，以及本人的资料）。query 用几个关键词；about 可选，填关于谁（handle 或姓名）。返回的记忆每条带编号 [M:xxxxxxxx]：回复用到哪条，就把它的编号原样写在那句话末尾。没有命中时返回“无结果”。",
	label: "正在查记忆…",
	schema: z.object({
		query: z.string().trim().min(1).max(200),
		about: z.string().trim().max(60).optional(),
	}),
	available: () => true,
	run: async ({ query, about }, scope) => {
		const res = await searchMemory(
			scope.s,
			{
				ownerId: scope.owner.id,
				requesterId:
					scope.actingFor.kind === "other" ? scope.actingFor.principalId : null,
			},
			{ query, ...(about ? { about } : {}) },
		);
		for (const [mark, citation] of res.citable)
			scope.session.citable.set(mark, citation);
		return {
			result: res.lines.length === 0 ? "无结果" : res.lines.join("\n"),
			summary: res.summary,
			ok: true,
		};
	},
});

/**
 * memory_save：个人代理为本人时记进本人的私有记忆；单元分身记进单元资料（仅单元成员可见）。
 */
export const memorySaveTool = makeTool({
	name: "memory_save",
	description:
		"把值得以后记住的事记下来：替本人办事时记进本人的私有记忆；部门的分身记进部门的单元资料（只有部门成员看得到）。",
	label: "正在记下…",
	schema: z.object({
		title: z.string().trim().min(1).max(120),
		body: z.string().trim().max(8000),
	}),
	available: (scope) => forOwner(scope) || scope.unit !== null,
	run: async ({ title, body }, scope) => {
		const unit = scope.unit !== null;
		await createNote(scope.s, {
			ownerId: scope.owner.id,
			authorId: scope.agent.principal.id,
			title,
			body,
			visibility: unit ? "unit" : "private",
		});
		return {
			result: unit
				? `已记进${scope.owner.displayName}的单元资料《${title}》`
				: `已记下《${title}》`,
			summary: unit ? `记进单元资料《${title}》` : `记下了《${title}》`,
			ok: true,
		};
	},
});

/**
 * record_decision：单元分身按章程做了决定时记下来——写一条单元资料（visibility=unit，作者为分身），
 * 同时写一条 subject = 单元、可见范围为该单元的 decision 记忆，出处指向这条资料。
 */
export const recordDecisionTool = makeTool({
	name: "record_decision",
	description:
		"按章程替部门做了决定（不是单纯答复已有信息）时调用，把决定记进部门的单元资料与记忆。title 一句话概括决定；body 写清决定内容、依据的章程条款、是替谁做的。",
	label: "正在记下决定…",
	schema: z.object({
		title: z.string().trim().min(1).max(120),
		body: z.string().trim().min(1).max(4000),
	}),
	available: (scope) =>
		scope.unit !== null && scope.conversation.kind !== "negotiation",
	run: async ({ title, body }, scope) => {
		await recordUnitDecision(scope.s, {
			unitId: scope.owner.id,
			authorId: scope.agent.principal.id,
			title,
			body,
			runId: scope.runId,
		});
		return {
			result: `已记下决定《${title}》`,
			summary: `记下决定《${title}》`,
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
		const decider = deciderIn(scope);
		const item = await createWorkItem(scope.s, {
			kind: "commitment",
			payload: {},
			title,
			body: `${scope.agent.principal.displayName}记下的承诺`,
			ownerId: decider.id,
			requesterId,
			conversationId: scope.conversation.id,
			dueAt: dueAt ? new Date(dueAt) : null,
		});
		notifyWorkItem(item);
		return {
			result: `已给${decider.displayName}建待办：${title}`,
			summary: `建了待办“${title}”`,
			ok: true,
		};
	},
});
