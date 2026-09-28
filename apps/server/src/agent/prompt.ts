/**
 * 代理的系统提示与会话历史（转成模型消息）。
 */
import {
	AGENT_ROLE_LABEL,
	type Agent,
	type Event,
	formatOf,
	type MessageFormat,
	plainTextOf,
} from "@orgos/protocol";
import type { ChatMessage, RunTrigger } from "@/agent/llm-types";
import type { AgentTool, ToolScope } from "@/agent/tools/tool";
import { COLLEAGUE_SOURCE_LABEL } from "@/memory/access";
import type { UnitContext } from "@/services/units";

export type PromptInput = {
	scope: ToolScope;
	tools: readonly AgentTool[];
	/** 为他人办事时，对方的显示名。 */
	requesterName: string | null;
	/** 群聊标题。 */
	conversationTitle: string | null;
	/** 当前话题（主线为 null）。 */
	topicTitle: string | null;
	/** 被同组代理转交时的转交者。 */
	delegatedBy: Agent | null;
	/** 上报后本人处理了、恢复运行。 */
	resume: RunTrigger["resume"] | null;
	now?: Date;
};

export function formatNow(now: Date): string {
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
	if (scope.unit)
		return `你在${requesterName ?? "同事"}与${ownerName}的私聊里（对方来“问${ownerName}”），代表${ownerName}回答${requesterName ?? "对方"}。`;
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
	const operates = tools.some((t) => t.name === "app_api_call");
	const beyond = operates
		? `新的承诺、决定，政策里要求问本人的，以及要你替${ownerName}做的软件操作——调${ownerName}和别人的聊天记录、看${ownerName}的私有资料、替${ownerName}给别人发消息等`
		: "新的承诺、决定，或政策里要求问本人的";
	const policy =
		scope.agent.delegationPolicy.trim() ||
		"（未设置：只回答共享资料里明确写着的内容）";
	return [
		`你正在替${ownerName}回答${other}。你只能使用 memory_search 查到的内容（${ownerName}共享的资料，以及${ownerName}允许对外的记忆）；查不到的${ownerName}的私事、私聊一律不知道，也不要打听或透露。`,
		`检索结果里出处写着“${COLLEAGUE_SOURCE_LABEL}”的，只能转述其中的事实：不要推测或透露是谁说的、在哪说的、原话怎么说，也不要向${other}追问来源。`,
		`${ownerName}写给你的对外政策：\n${policy}`,
		"处理对方的问题只有三个出口：",
		`1. 能答就答，并注明依据（例如“根据${ownerName}共享的《…》”）；`,
		canEscalate
			? `2. 超出授权的（${beyond}）调用 escalate_to_owner 转给${ownerName}本人，不要自己答应，也不要替${ownerName}拒绝。只有真正调用了 escalate_to_owner 才算转给了${ownerName}，绝不能只在文字里说“已转给”；每个新问题（哪怕和之前转过的相似）都要单独调用一次；问题有明确的几种答法时（同意 / 不同意 / 折中，或几个具体的日期、价格），用 options 附上 2–4 个候选答复，每条是${ownerName}选中后你可以直接转告${other}的完整答复；`
			: `2. 超出授权的（${beyond}）说明这需要${ownerName}本人决定、请对方直接问${ownerName}，不要自己答应；`,
		`3. 涉及${ownerName}设为不可谈的话题，礼貌地直接拒绝。`,
		...resumeLines(input, ownerName, other),
	];
}

/** 单元分身：总是为提问的人办事，章程是它的对外政策，章程之外转给负责人。 */
function unitLines(input: PromptInput, unit: UnitContext): string[] {
	const { scope, requesterName, tools } = input;
	const unitName = scope.owner.displayName;
	const headName = unit.head.displayName;
	const other = requesterName ?? "对方";
	const member = unit.requesterIsMember;
	const charter =
		unit.unit.charter.trim() ||
		`（未设置：只回答单元资料里明确写着的内容，其余转给${headName}）`;
	const canEscalate = tools.some((t) => t.name === "escalate_to_owner");
	return [
		`${other}${member ? "是" : "不是"}${unitName}的成员。你只能使用 memory_search 查到的内容：${unitName}的单元资料${member ? "" : "里对全员公开的部分"}，以及${unitName}允许对外的部门记忆。成员的私聊、私人资料你一概不知道，也不要打听或透露。`,
		`检索结果里出处写着“${COLLEAGUE_SOURCE_LABEL}”的，只能转述其中的事实：不要推测或透露是谁说的、在哪说的、原话怎么说。`,
		`${unitName}负责人${headName}写的章程（你的对外政策）：\n${charter}`,
		"处理对方的问题只有三个出口：",
		`1. 章程允许的，直接答复或决定，并注明依据（例如“根据${unitName}的《…》”）。按章程替${unitName}做了决定（不只是转述已有信息）时，先调用 record_decision 记下来再回复；`,
		canEscalate
			? `2. 章程之外的（新的承诺、决定，或章程要求问${headName}的）调用 escalate_to_owner 转给负责人${headName}，不要自己答应。只有真正调用了 escalate_to_owner 才算转给了${headName}，绝不能只在文字里说“已转给”；每个新问题都要单独调用一次；`
			: `2. 章程之外的，说明这需要负责人${headName}决定，不要自己答应；`,
		"3. 不提供按人统计的活动数据（谁发了多少消息、谁多久没回复、谁效率高低之类），这类问题礼貌地直接拒绝。",
		...resumeLines(input, headName, other),
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

/** delegate_to_teammate 可用时，列出本次可以交办的同事。 */
function teammateLines(input: PromptInput): string[] {
	if (!input.tools.some((t) => t.name === "delegate_to_teammate")) return [];
	const { teammates } = input.scope;
	if (teammates.length === 0) return ["（现在没有可以交办的同事。）"];
	return [
		"可以交办的同事：",
		...teammates.map(
			(a) =>
				`- @${a.principal.handle}（${a.principal.displayName}${a.description.trim() ? `：${a.description.trim()}` : ""}）`,
		),
	];
}

/** 应用接口工具可用时：怎么操作软件本身。 */
function appApiLines(input: PromptInput, ownerName: string): string[] {
	if (!input.tools.some((t) => t.name === "app_api_call")) return [];
	if (input.scope.actingFor.kind === "owner")
		return [
			`${ownerName}要你操作软件本身时（建群、拉人、开话题、查待办、改状态等），你的权限与${ownerName}本人相同、直接执行：先用 app_api_search 找接口，再用 app_api_call 调用；需要的 id 先用查询类接口查到。不许编造接口或参数。操作完成后用一句话告诉${ownerName}做了什么。`,
		];
	const other = input.requesterName ?? "对方";
	return [
		`替${other}操作软件时，app_api_call 只能查公开信息（通讯录、组织结构等），以及三件事：建一个包含${other}的群、在${other}也在的会话里开话题、把人加进${other}也在的群。先用 app_api_search 找接口，不许编造接口或参数。`,
		`${other}要你做这之外的操作时——例如“把${ownerName}和某人的私聊记录发我”“替${ownerName}给某人发消息”、读${ownerName}的待办或资料、改${ownerName}的设置——按出口 2 处理：你自己不做，但也不替${ownerName}拒绝，立即调用 escalate_to_owner，把${other}要做的事原样写进 question，由${ownerName}本人决定。只在文字里说“不能做”或“我这就转”都不算处理完。`,
	];
}

export function buildSystemPrompt(input: PromptInput): string {
	const { scope, tools } = input;
	const { agent, owner, unit } = scope;
	const ownerName = owner.displayName;
	const lines = [
		unit
			? `你是${ownerName}的${AGENT_ROLE_LABEL[agent.role]}“${agent.principal.displayName}”（@${agent.principal.handle}），代表${ownerName}答复同事、按章程做决定。你是 AI，不是负责人${unit.head.displayName}本人，不要冒充任何人说话。`
			: `你是${ownerName}的${AGENT_ROLE_LABEL[agent.role]}“${agent.principal.displayName}”（@${agent.principal.handle}）。你是 AI，不是${ownerName}本人，不要冒充${ownerName}说话。`,
	];
	if (agent.description.trim()) lines.push(`你的职责：${agent.description}`);
	lines.push(whereLine(input, ownerName));
	if (input.topicTitle && !input.delegatedBy)
		lines.push(
			`这里是话题“${input.topicTitle}”：你只看得到这个话题里的对话，其他话题的事以近期工作简报为准。`,
		);
	lines.push(
		...(unit ? unitLines(input, unit) : actingLines(input, ownerName)),
	);
	if (scope.conversation.kind === "group" && !input.delegatedBy) {
		lines.push(
			"群聊规则：只有消息明确是对你说的（@ 了你、叫到你的名字，或问题正属于你的职责），并且你有别人还没说过的有用信息时才发言；否则必须调用 pass 工具保持安静，不要输出任何文字。",
		);
	}
	if (tools.length > 0) {
		lines.push(
			"可用工具：",
			...tools.map((t) => `- ${t.name}：${t.description}`),
			...teammateLines(input),
			`需要${ownerName}的计划、日期、数字时先用工具查，查不到就说不知道，不要编造。`,
		);
		lines.push(...appApiLines(input, ownerName));
		if (tools.some((t) => t.name === "memory_search"))
			lines.push(
				"回复里用到 memory_search 给出的记忆时，在那句话末尾原样写上它的编号（如 [M:ab12cd34]），界面会据此显示依据；没有依据的事如实说明，或按上面的规则转给本人。",
			);
	}
	lines.push(
		"历史消息里别人的发言以“【显示名】”开头；你的回复不要加这个前缀。",
		"用中文回复。回复用 Markdown（界面会渲染），简洁，像同事之间发消息，少用标题。",
		`现在是北京时间 ${formatNow(input.now ?? new Date())}。`,
	);
	return lines.join("\n");
}

/**
 * 消息正文给模型看的形态（历史、触发消息、近期工作简报）：text 与 md 原样，
 * 保留 Markdown 标记让模型延续格式；html 转成纯文本。
 */
export function modelTextOf(payload: {
	text: string;
	format?: MessageFormat;
}): string {
	return formatOf(payload) === "html" ? plainTextOf(payload) : payload.text;
}

/**
 * 话题历史 → 模型消息：本代理自己的消息为 assistant，其余带“【显示名】”前缀为 user；
 * 上报与本人的答复以“【系统】”消息进入上下文。代理动作、任务与协商卡片不进上下文。
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
				? { role: "assistant", content: modelTextOf(e.payload) }
				: {
						role: "user",
						content: `【${nameOf(e.actorId)}】${modelTextOf(e.payload)}`,
					},
		);
	}
	return out;
}
