/**
 * 谁该回应一条新消息（规格"谁该回应"与假设 2）：纯函数，不碰数据库与运行时。
 *
 * - 本人与自己某个代理的私聊：本人发言时该代理总是回应，为本人办事。
 * - 两个真人的私聊（含双方分身）：对方 @ 了我的分身、切到"问分身"发送、或我忙碌 / 离开时，
 *   我的分身为对方办事；我自己的消息永远不触发我的分身；否则谁也不触发。
 * - 群聊：`agentsToTrigger` 只返回被 @ 的代理；`groupRound` 给出一轮的完整发言顺序
 *   （被 @ 的在前，其余按入群顺序），轮次的推进由调度器实现。
 * - 代理发的消息、协商会话：不触发任何代理（协商由协商流程自己驱动）。
 */
import type {
	AGENT_ROLES,
	CONVERSATION_KINDS,
	CONVERSATION_MEMBER_ROLES,
	PRINCIPAL_KINDS,
	PrincipalStatus,
} from "@orgos/protocol";

export type TriggerMember = {
	id: string;
	kind: (typeof PRINCIPAL_KINDS)[number];
	/** 代理所属的人；人为 null。 */
	ownerId: string | null;
	/** 代理的角色；人为 null。 */
	agentRole: (typeof AGENT_ROLES)[number] | null;
	/** 人的在线状态；代理为 null。 */
	status: PrincipalStatus | null;
	/** 在会话里的身份：observer 旁听，不参与判定。 */
	role: (typeof CONVERSATION_MEMBER_ROLES)[number];
};

export type TriggerConversation = {
	kind: (typeof CONVERSATION_KINDS)[number];
	members: readonly TriggerMember[];
};

export type TriggerMessage = {
	actorId: string;
	mentions: readonly string[];
	askTwin?: boolean;
};

/** 代理这次替谁办事：为本人，或为某位他人（提问的人）。 */
export type ActingFor =
	| { kind: "owner" }
	| { kind: "other"; principalId: string };

export type TriggerReason =
	| "own_dm"
	| "mentioned"
	| "ask_twin"
	| "owner_unavailable"
	/** 群聊里没被点名、按轮次轮到（可以无声跳过）。 */
	| "round";

export type Trigger = {
	agentId: string;
	actingFor: ActingFor;
	reason: TriggerReason;
};

const UNAVAILABLE: ReadonlySet<PrincipalStatus> = new Set(["busy", "away"]);

function participants(conv: TriggerConversation): TriggerMember[] {
	return conv.members.filter((m) => m.role === "member");
}

/**
 * 两个真人的私聊：kind=dm，恰好两个人是成员，其余成员都是这两人的分身。
 * 返回两个人；不是则返回 null。
 */
export function humanPairOf(
	conv: TriggerConversation,
): [TriggerMember, TriggerMember] | null {
	if (conv.kind !== "dm") return null;
	const members = participants(conv);
	const humans = members.filter((m) => m.kind === "human");
	const [a, b] = humans;
	if (humans.length !== 2 || !a || !b) return null;
	const onlyTheirTwins = members.every(
		(m) =>
			m.kind === "human" ||
			(m.agentRole === "front" && (m.ownerId === a.id || m.ownerId === b.id)),
	);
	return onlyTheirTwins ? [a, b] : null;
}

export function isHumanPairDm(conv: TriggerConversation): boolean {
	return humanPairOf(conv) !== null;
}

export function actingFor(
	agent: Pick<TriggerMember, "ownerId">,
	actorId: string,
): ActingFor {
	return agent.ownerId === actorId
		? { kind: "owner" }
		: { kind: "other", principalId: actorId };
}

function inHumanPairDm(
	pair: [TriggerMember, TriggerMember],
	conv: TriggerConversation,
	msg: TriggerMessage,
): Trigger[] {
	const [a, b] = pair;
	const other = a.id === msg.actorId ? b : a;
	const twin = participants(conv).find(
		(m) => m.agentRole === "front" && m.ownerId === other.id,
	);
	if (!twin) return [];
	const reason: TriggerReason | null = msg.mentions.includes(twin.id)
		? "mentioned"
		: msg.askTwin
			? "ask_twin"
			: other.status && UNAVAILABLE.has(other.status)
				? "owner_unavailable"
				: null;
	if (!reason) return [];
	return [
		{
			agentId: twin.id,
			actingFor: { kind: "other", principalId: msg.actorId },
			reason,
		},
	];
}

export function agentsToTrigger(
	conv: TriggerConversation,
	msg: TriggerMessage,
): Trigger[] {
	const members = participants(conv);
	const actor = members.find((m) => m.id === msg.actorId);
	if (actor?.kind !== "human") return [];

	switch (conv.kind) {
		case "negotiation":
			return [];
		case "dm": {
			const pair = humanPairOf(conv);
			if (pair) return inHumanPairDm(pair, conv, msg);
			const [agent, ...rest] = members.filter((m) => m.kind === "agent");
			const ownDm =
				agent &&
				rest.length === 0 &&
				members.length === 2 &&
				agent.ownerId === actor.id;
			return ownDm
				? [
						{
							agentId: agent.id,
							actingFor: { kind: "owner" },
							reason: "own_dm",
						},
					]
				: [];
		}
		case "group":
			return members
				.filter((m) => m.kind === "agent" && msg.mentions.includes(m.id))
				.map((agent) => ({
					agentId: agent.id,
					actingFor: actingFor(agent, actor.id),
					reason: "mentioned",
				}));
	}
}

/**
 * 群聊一轮的发言顺序（假设 5）：被 @ 的代理按 @ 的先后在前，其余代理按成员顺序（入群顺序）。
 * 只有人发的消息开启一轮；每个代理为发消息的人办事（是自己的本人则为本人）。
 */
export function groupRound(
	conv: TriggerConversation,
	msg: TriggerMessage,
): Trigger[] {
	if (conv.kind !== "group") return [];
	const members = participants(conv);
	const actor = members.find((m) => m.id === msg.actorId);
	if (actor?.kind !== "human") return [];
	const agents = members.filter((m) => m.kind === "agent");
	const mentioned = msg.mentions.flatMap((id) =>
		agents.filter((a) => a.id === id),
	);
	const others = agents.filter((a) => !msg.mentions.includes(a.id));
	return [
		...mentioned.map((a) => ({
			agentId: a.id,
			actingFor: actingFor(a, actor.id),
			reason: "mentioned" as const,
		})),
		...others.map((a) => ({
			agentId: a.id,
			actingFor: actingFor(a, actor.id),
			reason: "round" as const,
		})),
	];
}
