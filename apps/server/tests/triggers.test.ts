/**
 * 单元：谁该回应一条新消息（纯函数，不连库）。
 */
import type { PrincipalStatus } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import {
	agentsToTrigger,
	groupRound,
	isHumanPairDm,
	type TriggerConversation,
	type TriggerMember,
} from "@/agent/triggers";

function human(
	id: string,
	status: PrincipalStatus = "available",
): TriggerMember {
	return {
		id,
		kind: "human",
		ownerId: null,
		agentRole: null,
		status,
		role: "member",
	};
}

function twin(id: string, ownerId: string): TriggerMember {
	return {
		id,
		kind: "agent",
		ownerId,
		agentRole: "front",
		status: null,
		role: "member",
	};
}

function ops(id: string, ownerId: string): TriggerMember {
	return { ...twin(id, ownerId), agentRole: "specialist" };
}

const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";
const A_TWIN = "alice-twin";
const B_TWIN = "bob-twin";
const A_OPS = "alice-ops";
const B_OPS = "bob-ops";

function pairDm(
	aliceStatus: PrincipalStatus = "available",
	bobStatus: PrincipalStatus = "available",
): TriggerConversation {
	return {
		kind: "dm",
		members: [
			human(ALICE, aliceStatus),
			human(BOB, bobStatus),
			twin(A_TWIN, ALICE),
			twin(B_TWIN, BOB),
		],
	};
}

const say = (
	actorId: string,
	opts: { mentions?: string[]; askTwin?: boolean } = {},
) => ({ actorId, mentions: opts.mentions ?? [], askTwin: opts.askTwin });

describe("本人与自己代理的私聊", () => {
	it.each([
		["分身", twin(A_TWIN, ALICE)],
		["助手", ops(A_OPS, ALICE)],
	])("本人发言，%s总是回应、为本人办事", (_, agent) => {
		const conv: TriggerConversation = {
			kind: "dm",
			members: [human(ALICE, "busy"), agent],
		};
		expect(agentsToTrigger(conv, say(ALICE))).toEqual([
			{ agentId: agent.id, actingFor: { kind: "owner" }, reason: "own_dm" },
		]);
	});

	it("代理自己发的消息不触发", () => {
		const conv: TriggerConversation = {
			kind: "dm",
			members: [human(ALICE), twin(A_TWIN, ALICE)],
		};
		expect(agentsToTrigger(conv, say(A_TWIN))).toEqual([]);
	});

	it("与别人代理的私聊不是合法形态，不触发", () => {
		const conv: TriggerConversation = {
			kind: "dm",
			members: [human(ALICE), twin(B_TWIN, BOB)],
		};
		expect(agentsToTrigger(conv, say(ALICE))).toEqual([]);
	});
});

describe("两个真人的私聊", () => {
	it("双方在线、没点名：谁也不触发", () => {
		expect(agentsToTrigger(pairDm(), say(BOB))).toEqual([]);
		expect(agentsToTrigger(pairDm(), say(ALICE))).toEqual([]);
	});

	it("@ 对方的分身 → 触发对方分身，为提问的人办事", () => {
		expect(agentsToTrigger(pairDm(), say(BOB, { mentions: [A_TWIN] }))).toEqual(
			[
				{
					agentId: A_TWIN,
					actingFor: { kind: "other", principalId: BOB },
					reason: "mentioned",
				},
			],
		);
	});

	it("切到问分身发送 → 触发对方分身（不是自己的）", () => {
		expect(agentsToTrigger(pairDm(), say(ALICE, { askTwin: true }))).toEqual([
			{
				agentId: B_TWIN,
				actingFor: { kind: "other", principalId: ALICE },
				reason: "ask_twin",
			},
		]);
	});

	it.each(["busy", "away"] as const)(
		"对方状态为 %s → 不点名也触发对方分身",
		(status) => {
			expect(agentsToTrigger(pairDm(status), say(BOB))).toEqual([
				{
					agentId: A_TWIN,
					actingFor: { kind: "other", principalId: BOB },
					reason: "owner_unavailable",
				},
			]);
		},
	);

	it("我自己的消息永远不触发我的分身：@ 自己分身、自己忙碌都不行", () => {
		expect(agentsToTrigger(pairDm("busy"), say(ALICE))).toEqual([]);
		expect(
			agentsToTrigger(pairDm("away"), say(ALICE, { mentions: [A_TWIN] })),
		).toEqual([]);
	});

	it("我忙碌时对方问分身：只触发我的分身一次", () => {
		const out = agentsToTrigger(
			pairDm("busy"),
			say(BOB, { askTwin: true, mentions: [A_TWIN, B_TWIN] }),
		);
		expect(out).toEqual([
			{
				agentId: A_TWIN,
				actingFor: { kind: "other", principalId: BOB },
				reason: "mentioned",
			},
		]);
	});

	it("@ 自己的分身不会顺带触发对方分身", () => {
		expect(agentsToTrigger(pairDm(), say(BOB, { mentions: [B_TWIN] }))).toEqual(
			[],
		);
	});

	it("分身在私聊里的发言不触发任何代理", () => {
		expect(
			agentsToTrigger(pairDm("busy", "busy"), say(A_TWIN, { askTwin: true })),
		).toEqual([]);
	});

	it("observer 不参与判定；非成员发言不触发", () => {
		const conv = pairDm("busy");
		const withObserver: TriggerConversation = {
			...conv,
			members: [...conv.members, { ...human(CAROL), role: "observer" }],
		};
		expect(isHumanPairDm(withObserver)).toBe(true);
		expect(agentsToTrigger(withObserver, say(CAROL))).toEqual([]);
	});
});

describe("isHumanPairDm", () => {
	it("两人加双方分身才算；缺分身也算（分身不开口时照样是两人私聊）", () => {
		expect(isHumanPairDm(pairDm())).toBe(true);
		expect(
			isHumanPairDm({ kind: "dm", members: [human(ALICE), human(BOB)] }),
		).toBe(true);
	});

	it("自己与代理的私聊、群聊、协商、混入助手或第三人都不算", () => {
		expect(
			isHumanPairDm({
				kind: "dm",
				members: [human(ALICE), twin(A_TWIN, ALICE)],
			}),
		).toBe(false);
		expect(isHumanPairDm({ ...pairDm(), kind: "group" })).toBe(false);
		expect(isHumanPairDm({ ...pairDm(), kind: "negotiation" })).toBe(false);
		expect(
			isHumanPairDm({
				kind: "dm",
				members: [...pairDm().members, ops(B_OPS, BOB)],
			}),
		).toBe(false);
		expect(
			isHumanPairDm({
				kind: "dm",
				members: [human(ALICE), human(BOB), twin("carol-twin", CAROL)],
			}),
		).toBe(false);
	});
});

describe("群聊", () => {
	const group: TriggerConversation = {
		kind: "group",
		members: [
			human(ALICE),
			human(BOB, "busy"),
			twin(A_TWIN, ALICE),
			ops(A_OPS, ALICE),
			twin(B_TWIN, BOB),
		],
	};

	it("只返回被 @ 的代理；自己的代理为本人，别人的分身为提问者", () => {
		expect(
			agentsToTrigger(group, say(ALICE, { mentions: [A_OPS, B_TWIN, BOB] })),
		).toEqual([
			{ agentId: A_OPS, actingFor: { kind: "owner" }, reason: "mentioned" },
			{
				agentId: B_TWIN,
				actingFor: { kind: "other", principalId: ALICE },
				reason: "mentioned",
			},
		]);
	});

	it("没人被 @ 时不触发（忙碌与问分身只在两人私聊里生效）", () => {
		expect(agentsToTrigger(group, say(ALICE, { askTwin: true }))).toEqual([]);
	});

	it("代理在群里 @ 别的代理不触发", () => {
		expect(agentsToTrigger(group, say(A_TWIN, { mentions: [A_OPS] }))).toEqual(
			[],
		);
	});
});

describe("协商会话", () => {
	it("不经本判定触发任何代理", () => {
		const conv: TriggerConversation = {
			kind: "negotiation",
			members: [
				twin(A_TWIN, ALICE),
				twin(B_TWIN, BOB),
				{ ...human(ALICE), role: "observer" },
				{ ...human(BOB), role: "observer" },
			],
		};
		expect(agentsToTrigger(conv, say(ALICE, { mentions: [A_TWIN] }))).toEqual(
			[],
		);
		expect(agentsToTrigger(conv, say(A_TWIN))).toEqual([]);
	});
});

describe("群聊一轮的发言顺序", () => {
	const group: TriggerConversation = {
		kind: "group",
		members: [
			human(ALICE),
			human(BOB),
			twin(A_TWIN, ALICE),
			ops(A_OPS, ALICE),
			twin(B_TWIN, BOB),
		],
	};

	const other = (principalId: string) => ({ kind: "other", principalId });
	const withStatus = (id: string, status: PrincipalStatus) => ({
		...group,
		members: group.members.map((m) => (m.id === id ? { ...m, status } : m)),
	});

	it("被点到的按 @ 的先后在前，其余非分身代理按入群顺序；各自为发消息的人办事", () => {
		expect(groupRound(group, say(BOB, { mentions: [A_TWIN, A_OPS] }))).toEqual([
			{ agentId: A_TWIN, actingFor: other(BOB), reason: "mentioned" },
			{ agentId: A_OPS, actingFor: other(BOB), reason: "mentioned" },
		]);
		expect(groupRound(group, say(BOB)).map((t) => t.agentId)).toEqual([A_OPS]);
	});

	it("分身三种触发：@ 了分身；@ 了本人且问分身；@ 了本人且本人忙碌 / 离开——都为发言者办事", () => {
		expect(groupRound(group, say(BOB, { mentions: [A_TWIN] }))[0]).toEqual({
			agentId: A_TWIN,
			actingFor: other(BOB),
			reason: "mentioned",
		});
		expect(
			groupRound(group, say(BOB, { mentions: [ALICE], askTwin: true }))[0],
		).toEqual({ agentId: A_TWIN, actingFor: other(BOB), reason: "ask_twin" });
		for (const status of ["busy", "away"] as const)
			expect(
				groupRound(
					withStatus(ALICE, status),
					say(BOB, { mentions: [ALICE] }),
				)[0],
			).toEqual({
				agentId: A_TWIN,
				actingFor: other(BOB),
				reason: "owner_unavailable",
			});
		// 本人在线、只 @ 本人不问分身：分身不开口。
		expect(
			groupRound(group, say(BOB, { mentions: [ALICE] })).map((t) => t.agentId),
		).toEqual([A_OPS]);
	});

	it("本人 @ 自己的分身：为本人办事", () => {
		expect(groupRound(group, say(ALICE, { mentions: [A_TWIN] }))[0]).toEqual({
			agentId: A_TWIN,
			actingFor: { kind: "owner" },
			reason: "mentioned",
		});
	});

	it("本人忙碌但没被点名：分身不开口；本人没 @ 自己的分身时不触发它", () => {
		const busy = withStatus(ALICE, "busy");
		expect(groupRound(busy, say(BOB)).map((t) => t.agentId)).toEqual([A_OPS]);
		expect(groupRound(busy, say(ALICE)).map((t) => t.agentId)).toEqual([A_OPS]);
		expect(
			groupRound(busy, say(ALICE, { mentions: [BOB] })).map((t) => t.agentId),
		).toEqual([A_OPS]);
		expect(
			agentsToTrigger(busy, say(BOB, { askTwin: true })).map((t) => t.agentId),
		).toEqual([]);
		expect(
			agentsToTrigger(busy, say(BOB, { mentions: [ALICE] })).map(
				(t) => t.agentId,
			),
		).toEqual([A_TWIN]);
	});

	it("代理发的消息、私聊不开启一轮", () => {
		expect(groupRound(group, say(A_TWIN))).toEqual([]);
		expect(groupRound(pairDm(), say(ALICE))).toEqual([]);
	});

	it("observer 不参与", () => {
		const withObserver: TriggerConversation = {
			...group,
			members: [...group.members, { ...ops(B_OPS, BOB), role: "observer" }],
		};
		expect(groupRound(withObserver, say(ALICE)).map((t) => t.agentId)).toEqual([
			A_OPS,
		]);
	});
});
