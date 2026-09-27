/**
 * 代理的系统提示与会话历史（转成模型消息）。
 */
import { AGENT_ROLE_LABEL, type Agent, type Event } from "@orgos/protocol";
import type { ChatMessage, RunTrigger } from "@/agent/llm-types";
import type { AgentTool, ToolScope } from "@/agent/tools/tool";

export type PromptInput = {
	scope: ToolScope;
	tools: readonly AgentTool[];
	/** 为他人办事时，对方的显示名。 */
	requesterName: string | null;
	/** 群聊标题。 */
	conversationTitle: string | null;
	/** 被同组代理转交时的转交者。 */
	delegatedBy: Agent | null;
	/** 上报后本人处理了、恢复运行。 */
	resume: RunTrigger["resume"] | null;
	now?: Date;
};

function formatNow(now: Date): string {
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		dateStyle: "full",
		timeStyle: "short",
	}).format(now);
}

function whereLine(input: PromptInput, ownerName: string): string {
	const { scope, requesterName, conversationTitle, delegatedBy } = input;
	if (delegatedBy)
		return `${delegatedBy.principal.displayName}把一件活转交给你，完成后你的回复会原样交回给它。`;
	if (scope.conversation.kind === "group")
		return `你在群聊“${conversationTitle ?? "群聊"}”里，多位同事和代理都在。`;
	if (scope.actingFor.kind === "other")
		return `你在${ownerName}与${requesterName ?? "同事"}的私聊里，替${ownerName}回答${requesterName ?? "对方"}。`;
	return `你在和${ownerName}本人私聊。`;
}

function actingLines(input: PromptInput, ownerName: string): string[] {
	const { scope, requesterName, tools } = input;
	if (scope.actingFor.kind === "owner") {
		return [
			`你正在为${ownerName}本人办事，可以使用${ownerName}的全部资料与记忆。`,
		];
	}
	const other = requesterName ?? "对方";
	const canEscalate = tools.some((t) => t.name === "escalate_to_owner");
	const policy =
		scope.agent.delegationPolicy.trim() ||
		"（未设置：只回答共享资料里明确写着的内容）";
	return [
		`你正在替${ownerName}回答${other}。你只能使用${ownerName}标为共享的资料；${ownerName}的私聊、私有记忆一律不可用，也不要透露。`,
		`${ownerName}写给你的对外政策：\n${policy}`,
		"处理对方的问题只有三个出口：",
		`1. 能答就答，并注明依据（例如“根据${ownerName}共享的《…》”）；`,
		canEscalate
			? `2. 超出授权的（新的承诺、决定，或政策里要求问本人的）调用 escalate_to_owner 转给${ownerName}本人，不要自己答应。只有真正调用了 escalate_to_owner 才算转给了${ownerName}，绝不能只在文字里说“已转给”；每个新问题（哪怕和之前转过的相似）都要单独调用一次；`
			: `2. 超出授权的（新的承诺、决定，或政策里要求问本人的）说明这需要${ownerName}本人决定、请对方直接问${ownerName}，不要自己答应；`,
		`3. 涉及${ownerName}设为不可谈的话题，礼貌地直接拒绝。`,
		...resumeLines(input, ownerName, other),
	];
}

function resumeLines(
	input: PromptInput,
	ownerName: string,
	other: string,
): string[] {
	if (!input.resume) return [];
	return input.resume.declined
		? [
				`${ownerName}本人刚刚看了你转交的问题，决定暂不答复（附言见历史里最新的系统消息）。现在礼貌地告诉${other}：${ownerName}暂时不答复这个问题；不要替${ownerName}回答，也不要再次转交。`,
			]
		: [
				`${ownerName}本人刚刚答复了你转交的问题（见历史里最新的系统消息）。现在把答复转告${other}，注明这是${ownerName}本人的答复，不要改变答复的意思；不要再次转交同一个问题。`,
			];
}

export function buildSystemPrompt(input: PromptInput): string {
	const { scope, tools } = input;
	const { agent, owner } = scope;
	const ownerName = owner.displayName;
	const lines = [
		`你是${ownerName}的${AGENT_ROLE_LABEL[agent.role]}“${agent.principal.displayName}”（@${agent.principal.handle}）。你是 AI，不是${ownerName}本人，不要冒充${ownerName}说话。`,
	];
	if (agent.description.trim()) lines.push(`你的职责：${agent.description}`);
	lines.push(whereLine(input, ownerName), ...actingLines(input, ownerName));
	if (scope.conversation.kind === "group" && !input.delegatedBy) {
		lines.push(
			"群聊规则：只有消息明确是对你说的（@ 了你、叫到你的名字，或问题正属于你的职责），并且你有别人还没说过的有用信息时才发言；否则必须调用 pass 工具保持安静，不要输出任何文字。",
		);
	}
	if (tools.length > 0) {
		lines.push(
			"可用工具：",
			...tools.map((t) => `- ${t.name}：${t.description}`),
			`需要${ownerName}的计划、日期、数字时先用工具查，查不到就说不知道，不要编造。`,
		);
	}
	lines.push(
		"历史消息里别人的发言以“【显示名】”开头；你的回复不要加这个前缀。",
		"用中文，简洁，像同事之间发消息；不用 Markdown 标题。",
		`现在是北京时间 ${formatNow(input.now ?? new Date())}。`,
	);
	return lines.join("\n");
}

/**
 * 会话历史 → 模型消息：本代理自己的消息为 assistant，其余带“【显示名】”前缀为 user；
 * 上报与本人的答复以“【系统】”消息进入上下文。代理动作与协商卡片不进上下文。
 */
export function historyMessages(
	events: readonly Event[],
	agentId: string,
	nameOf: (principalId: string) => string,
): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const e of events) {
		if (e.type === "escalation.created") {
			out.push({
				role: "user",
				content: `【系统】${nameOf(e.actorId)}已把问题转给本人，等待本人答复：${e.payload.question}`,
			});
			continue;
		}
		if (e.type === "escalation.resolved") {
			const text = e.payload.text ? `：${e.payload.text}` : "";
			out.push({
				role: "user",
				content:
					e.payload.action === "decline"
						? `【系统】${nameOf(e.actorId)}本人暂不答复转来的问题${text}`
						: `【系统】${nameOf(e.actorId)}本人答复了转来的问题${text}`,
			});
			continue;
		}
		if (e.type !== "message.posted") continue;
		out.push(
			e.actorId === agentId
				? { role: "assistant", content: e.payload.text }
				: {
						role: "user",
						content: `【${nameOf(e.actorId)}】${e.payload.text}`,
					},
		);
	}
	return out;
}
