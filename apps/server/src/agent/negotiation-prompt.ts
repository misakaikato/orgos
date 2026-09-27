/**
 * 协商会话里分身的系统提示与上下文：协议与状态语义、目标、本人的约束，
 * 以及把协商步骤序列写成结构化文本（对方与自己的每一步：状态、说明、proposal）。
 */
import { AGENT_ROLE_LABEL } from "@orgos/protocol";
import type { ChatMessage } from "@/agent/llm-types";
import { formatNow } from "@/agent/prompt";
import type { AgentTool, ToolScope } from "@/agent/tools/tool";
import type { NegotiationContext, StepEvent } from "@/services/negotiations";

const STATUS_TEXT: Record<StepEvent["payload"]["status"], string> = {
	continue: "continue（提议或回应）",
	agree: "agree（同意）",
	reject: "reject（拒绝）",
	need_owner: "need_owner（请本人定）",
};

function json(value: unknown): string {
	return JSON.stringify(value);
}

function constraintLines(
	ctx: NegotiationContext,
	ownerName: string,
	policy: string,
): string[] {
	const lines: string[] = [];
	if (ctx.role === "initiator") {
		lines.push(
			ctx.request.length > 0
				? `${ownerName}让你去协商时和你的对话如下（${ownerName}的要求与约束以此为准，谈成的方案必须全部满足）：\n${ctx.request
						.map((m) => `${m.self ? "你" : ownerName}：${m.text}`)
						.join("\n")}`
				: `协商目标就是${ownerName}的要求，谈成的方案必须满足目标里的全部约束。`,
			`${ownerName}给的约束就是你的依据：对方的方案只要落在约束范围内（例如说了“下午”，下午的任意时段都算），就直接 agree，不要再问${ownerName}；只有超出约束、或约束没覆盖到的新承诺，才用 need_owner。`,
		);
	} else {
		lines.push(
			`这次协商是对方发起的，${ownerName}事先没有给你指示。${ownerName}的日程、偏好等先用 memory_search 查一两次${ownerName}的资料（用两三个关键词，别反复换说法重查）。你看不到${ownerName}的日历：资料里没写、${ownerName}也没答复过的，不要替${ownerName}接受、拒绝或另提具体时间，更不要编造${ownerName}“已有安排”——凡是会替${ownerName}做出承诺（占用${ownerName}的时间、答应交付等）而你没有依据的，用 need_owner 问${ownerName}。`,
		);
	}
	lines.push(
		`${ownerName}写给你的对外政策（政策要求问本人的事一律用 need_owner）：\n${policy}`,
	);
	if (ctx.ownerAnswers.length > 0) {
		lines.push(
			`${ownerName}本人对你在这次协商里提的问题的答复（这是${ownerName}的最终意见，照此继续，不要为同一件事再次 need_owner）：\n${ctx.ownerAnswers
				.map(
					(a) =>
						`问：${a.question}\n答：${
							a.declined
								? `${ownerName}暂不答复${a.text ? `（${a.text}）` : ""}`
								: (a.text ?? "")
						}`,
				)
				.join("\n")}`,
		);
	}
	return lines;
}

export function buildNegotiationPrompt(input: {
	scope: ToolScope;
	tools: readonly AgentTool[];
	ctx: NegotiationContext;
	now?: Date;
}): string {
	const { scope, tools, ctx } = input;
	const { agent, owner, unit } = scope;
	const ownerName = owner.displayName;
	const otherName = ctx.counterpartOwner.displayName;
	// 单元一方：章程是对外政策，拍板的是负责人。
	const boss = unit ? `${ownerName}负责人${unit.head.displayName}` : ownerName;
	const policy =
		(unit ? unit.unit.charter : agent.delegationPolicy).trim() ||
		"（未设置：凡是替本人做承诺的都先问本人）";
	const lines = [
		`你是${ownerName}的${AGENT_ROLE_LABEL[agent.role]}“${agent.principal.displayName}”（@${agent.principal.handle}）。你是 AI，不是${ownerName}本人，不要冒充${ownerName}。`,
		...(agent.description.trim() ? [`你的职责：${agent.description}`] : []),
		`你正在代表${ownerName}，和${otherName}的分身“${ctx.counterpart.displayName}”协商。这是${ctx.role === "initiator" ? "你" : "对方"}发起的协商，目标：${ctx.state.goal}`,
		`你为${ownerName}本人办事，可以查阅${ownerName}的全部资料与记忆；只对对方说达成目标所需的信息，不要透露${ownerName}的私事。不要编造${ownerName}的日程或安排。`,
		...constraintLines(ctx, ownerName, policy),
		"协商规则（结构化协议，不是聊天）：",
		"1. 每一轮你必须调用一次 negotiation_reply 结束，不要只输出文字；需要查资料可以先调用 memory_search（一两次即可，查不到就别换说法反复查）。",
		"2. continue：提出新方案或修改方案，proposal 里写完整方案（不是只写改动）；也用于回应对方但暂不同意。",
		`3. agree：接受对方最近一次提出的 proposal，必须把它原样（逐字段相同）放进 proposal。只有一方 agree 了另一方最近的 proposal，协商才算谈成；不能 agree 自己提的方案。`,
		`4. reject：这件事谈不成（对方的要求和${ownerName}的约束根本冲突），协商随即终止。`,
		`5. need_owner：拿不准、需要${boss}本人拍板；message 写清要问${boss}什么。${boss}答复后你会接着这一轮继续。`,
		'6. proposal 是 JSON 对象，用简短的中文键值写出一个确定的方案，例如 {"日期":"9 月 29 日（周二）","时间":"15:00-15:45","事项":"结算页接口评审"}。时间要落到具体的日期与钟点；一个 proposal 里只放一个方案，不要放“备选”“候选”这类第二方案——备选写在 message 里，对方不接受时再作为新的 proposal 提出。',
		`7. 最多 ${ctx.state.maxSteps} 步，尽快收敛：对方的方案满足${ownerName}的约束就直接 agree；不满足就说明原因并给出具体的替代方案。`,
		`8. message 用一两句中文说明理由：continue / agree / reject 写给对方的分身；need_owner 写给${boss}本人，直接问清要${boss}定什么。`,
		"可用工具：",
		...tools.map((t) => `- ${t.name}：${t.description}`),
		`现在是北京时间 ${formatNow(input.now ?? new Date())}。`,
	];
	return lines.join("\n");
}

/** 协商至今的步骤序列，写成一条 user 消息；最后一行说明现在轮到谁、第几步。 */
export function negotiationMessages(
	ctx: NegotiationContext,
	selfId: string,
	nameOf: (principalId: string) => string,
	ownerName: string,
): ChatMessage[] {
	const rows = ctx.steps.map((e) => {
		const who = e.actorId === selfId ? "你" : nameOf(e.actorId);
		return [
			`第 ${e.payload.step} 步 · ${who} · ${STATUS_TEXT[e.payload.status]}`,
			`说明：${e.payload.message}`,
			...(e.payload.proposal === undefined
				? []
				: [`proposal：${json(e.payload.proposal)}`]),
		].join("\n");
	});
	const latest =
		ctx.state.lastProposal === undefined
			? "目前还没有人提出过 proposal。"
			: `目前最近一次提出的 proposal 来自${ctx.state.lastProposalBy === selfId ? "你" : "对方"}：${json(ctx.state.lastProposal)}`;
	const next = ctx.state.step + 1;
	return [
		{
			role: "user",
			content: [
				rows.length > 0
					? `协商记录：\n\n${rows.join("\n\n")}`
					: "协商刚开始，由你先提出第一个方案。",
				latest,
				...(ctx.role === "responder" && ctx.ownerAnswers.length === 0
					? [
							`提醒：你还没有就这件事问过${ownerName}。要接受、拒绝或另提会占用${ownerName}时间、替${ownerName}做承诺的方案，而资料里没有依据时，这一步用 need_owner。`,
						]
					: []),
				`现在轮到你走第 ${next} 步（共 ${ctx.state.maxSteps} 步），调用 negotiation_reply。`,
			].join("\n\n"),
		},
	];
}
