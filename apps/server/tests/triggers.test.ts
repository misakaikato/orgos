/**
 * 单元：谁该回应一条新消息（纯函数，不连库）。
 */
import type { PrincipalStatus } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import {
	agentsToTrigger,
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
