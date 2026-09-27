/**
 * 集成（MOCK_LLM=1）：C1 与自己的代理组对话、触发规则接线、为他人时的权限收窄、
 * knowledge_search 的共享过滤、转交的深度与限制传递。
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { llmRequests, notes } from "@/db/schema";
import { scoped } from "@/db/scope";
import {
	actions,
	captureFrames,
	eventsOf,
	messagesBy,
	openDm,
	say,
} from "./agent-helpers";
import { createTeam, type TeamMember } from "./helpers";

let alice: TeamMember;
let bob: TeamMember;
let aliceTwin: string;
let aliceOps: string;
let aliceOpsHandle: string;
let aliceTwinHandle: string;
let bobTwin: string;
let pairDm: string;

beforeAll(async () => {
	[alice, bob] = (await createTeam(["Alice", "Bob"])) as [
		TeamMember,
		TeamMember,
	];
	const [twin, ops] = alice.me.agents;
	aliceTwin = twin?.principal.id ?? "";
	aliceTwinHandle = twin?.principal.handle ?? "";
	aliceOps = ops?.principal.id ?? "";
	aliceOpsHandle = ops?.principal.handle ?? "";
	bobTwin = bob.me.agents[0]?.principal.id ?? "";
	pairDm = await openDm(bob.client, alice.me.principal.id);
	const shared = await alice.client.request("POST", "/api/notes", {
		title: "Q4 预算口径",
		body: "不含税",
		visibility: "shared",
	});
	expect(shared.status).toBe(201);
});

function tenant() {
	return scoped(alice.me.tenant.id);
}

describe("C1 本人与自己的代理", () => {
	it("对分身说“你好”：流式草稿 + 状态帧，回复“收到：你好”", async () => {
		const cid = await openDm(alice.client, aliceTwin);
		const cap = captureFrames(alice.me.principal.id);
		try {
			await say(alice.client, cid, "你好");
		} finally {
			cap.stop();
		}
		const replies = messagesBy(await eventsOf(alice.client, cid), aliceTwin);
		expect(replies.map((m) => m.payload.text)).toEqual(["收到：你好"]);
		expect(replies[0]?.onBehalfOfId).toBe(alice.me.principal.id);
		const drafts = cap.frames.filter((f) => f.t === "draft");
		expect(drafts.map((f) => (f.t === "draft" ? f.delta : "")).join("")).toBe(
			"收到：你好",
		);
		const states = cap.frames.flatMap((f) =>
			f.t === "status" ? [f.state] : [],
		);
		expect(states[0]).toBe("thinking");
		expect(states.at(-1)).toBe("idle");
	});

	it("#delegate：出现 delegate_to_teammate 动作，最终回复以“完成：”开头", async () => {
		const cid = await openDm(alice.client, aliceTwin);
		await say(alice.client, cid, `#delegate:${aliceOpsHandle} 整理周报`);
		const events = await eventsOf(alice.client, cid);
		const delegated = actions(events).find(
			(a) => a.payload.tool === "delegate_to_teammate",
		);
		expect(delegated?.payload.ok).toBe(true);
		expect(delegated?.actorId).toBe(aliceTwin);
		const reply = messagesBy(events, aliceTwin).at(-1);
		expect(reply?.payload.text).toBe("完成：收到：整理周报");
		expect(messagesBy(events, aliceOps)).toEqual([]);
	});

	it("#remember：notes 多一行 authorId=分身、private", async () => {
		const cid = await openDm(alice.client, aliceTwin);
		await say(alice.client, cid, "#remember 私事|下周三请假看牙");
		const rows = await tenant().select(
			notes,
			eq(notes.ownerId, alice.me.principal.id),
			eq(notes.authorId, aliceTwin),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			title: "私事",
			body: "下周三请假看牙",
			visibility: "private",
		});
	});

	it("本人查资料能看到私有记忆", async () => {
		const cid = await openDm(alice.client, aliceTwin);
		await say(alice.client, cid, "#note 看牙");
		const reply = messagesBy(await eventsOf(alice.client, cid), aliceTwin).at(
			-1,
		);
		expect(reply?.payload.text).toContain("请假");
	});

	it("#commit：给本人建承诺待办", async () => {
		const cid = await openDm(alice.client, aliceOps);
		await say(alice.client, cid, "#commit 周五前交周报");
		const res = await alice.client.request("GET", "/api/work-items");
		const { items } = (await res.json()) as {
			items: { kind: string; title: string; requesterId: string }[];
		};
		expect(items).toContainEqual(
			expect.objectContaining({
				kind: "commitment",
				title: "周五前交周报",
				requesterId: alice.me.principal.id,
			}),
		);
	});
});

describe("真人私聊里的触发接线", () => {
	it("对方 available、没点名：不运行任何代理，也不产生模型调用", async () => {
		await say(bob.client, pairDm, "#note 预算");
		const events = await eventsOf(bob.client, pairDm);
		expect(messagesBy(events, aliceTwin)).toEqual([]);
		expect(messagesBy(events, bobTwin)).toEqual([]);
		const calls = await tenant().select(
			llmRequests,
			eq(llmRequests.conversationId, pairDm),
		);
		expect(calls).toEqual([]);
	});

	it("askTwin：对方的分身为提问者办事，只能查到共享资料", async () => {
		await say(bob.client, pairDm, "#note 预算", { askTwin: true });
		let reply = messagesBy(await eventsOf(bob.client, pairDm), aliceTwin).at(
			-1,
		);
		expect(reply?.payload.text).toMatch(/^完成：/);
		expect(reply?.payload.text).toContain("不含税");

		await say(bob.client, pairDm, "#note 看牙", { askTwin: true });
		reply = messagesBy(await eventsOf(bob.client, pairDm), aliceTwin).at(-1);
		expect(reply?.payload.text).toContain("无结果");
		expect(reply?.payload.text).not.toContain("请假");

		const rows = await tenant().select(
			llmRequests,
			and(
				eq(llmRequests.conversationId, pairDm),
				eq(llmRequests.agentId, aliceTwin),
			),
		);
		expect(rows.every((r) => r.onBehalfOfId === bob.me.principal.id)).toBe(
			true,
		);
	});

	it("@ 对方分身同样触发；本人的发言不触发自己的分身", async () => {
		await say(bob.client, pairDm, `@${aliceTwinHandle} 在吗`, {
			mentions: [aliceTwin],
		});
		let events = await eventsOf(alice.client, pairDm);
		expect(messagesBy(events, aliceTwin).at(-1)?.payload.text).toBe(
			`收到：@${aliceTwinHandle} 在吗`,
		);
		const before = messagesBy(events, aliceTwin).length;
		await say(alice.client, pairDm, "我自己来回答");
		events = await eventsOf(alice.client, pairDm);
		expect(messagesBy(events, aliceTwin)).toHaveLength(before);
		expect(messagesBy(events, bobTwin)).toEqual([]);
	});

	it("为他人时编造调用私有工具 → 无权限，不写记忆", async () => {
		const before = await tenant().select(
			notes,
			eq(notes.ownerId, alice.me.principal.id),
		);
		await say(bob.client, pairDm, "#remember 偷偷|记一笔", { askTwin: true });
		const events = await eventsOf(bob.client, pairDm);
		expect(messagesBy(events, aliceTwin).at(-1)?.payload.text).toContain(
			"无权限",
		);
		expect(actions(events).at(-1)?.payload).toMatchObject({
			tool: "memory_save",
			ok: false,
		});
		const after = await tenant().select(
			notes,
			eq(notes.ownerId, alice.me.principal.id),
		);
		expect(after).toHaveLength(before.length);
	});
});

describe("转交", () => {
	it("为他人转交给助手：助手同样只能看共享资料、不能记私有记忆", async () => {
		await say(bob.client, pairDm, `#delegate:${aliceOpsHandle} #note 看牙`, {
			askTwin: true,
		});
		let reply = messagesBy(await eventsOf(bob.client, pairDm), aliceTwin).at(
			-1,
		);
		expect(reply?.payload.text).toContain("无结果");
		expect(reply?.payload.text).not.toContain("请假");

		await say(bob.client, pairDm, `#delegate:${aliceOpsHandle} #remember a|b`, {
			askTwin: true,
		});
		reply = messagesBy(await eventsOf(bob.client, pairDm), aliceTwin).at(-1);
		expect(reply?.payload.text).toContain("无权限");
	});

	it("为他人时助手只能转交给助手：转给分身 → 无权限", async () => {
		await say(
			bob.client,
			pairDm,
			`#delegate:${aliceOpsHandle} #delegate:${aliceTwinHandle} 帮忙`,
			{ askTwin: true },
		);
		const delegations = actions(await eventsOf(bob.client, pairDm)).filter(
			(a) => a.payload.tool === "delegate_to_teammate",
		);
		expect(delegations.slice(-2).map((a) => a.payload)).toEqual([
			expect.objectContaining({
				ok: false,
				summary: expect.stringContaining("无权限"),
			}),
			expect.objectContaining({ ok: true }),
		]);
	});

	it("深度 ≤ 2：第三层的代理没有转交工具", async () => {
		const cid = await openDm(alice.client, aliceTwin);
		await say(
			alice.client,
			cid,
			`#delegate:${aliceOpsHandle} #delegate:${aliceTwinHandle} #delegate:${aliceOpsHandle} 太深了`,
		);
		const events = await eventsOf(alice.client, cid);
		const delegations = actions(events)
			.filter((a) => a.payload.tool === "delegate_to_teammate")
			.slice(-3);
		expect(delegations.map((a) => a.payload.ok)).toEqual([false, true, true]);
		expect(delegations[0]?.payload.summary).toContain("无权限");
		expect(delegations.every((a) => a.actorId === aliceTwin)).toBe(true);
		expect(messagesBy(events, aliceTwin).at(-1)?.payload.text).toContain(
			"无权限",
		);
	});
});
