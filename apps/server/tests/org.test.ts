/**
 * 集成（MOCK_LLM=1）：组织结构与部门分身——约束、单元树与成员、权限、问部门（私聊）、单元群 @ 规则、
 * 章程内记决定与章程外上报、单元资料与记忆的可见性（成员 / 非成员、第三人规则）、与单元协商、硬边界、
 * 负责人的单元记忆与代答记录。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ErrorBodySchema,
	OrgResponseSchema,
	type OrgUnit,
	OrgUnitResponseSchema,
	TwinAnswerListResponseSchema,
	UnitDetailResponseSchema,
	type WorkItem,
	WorkItemListResponseSchema,
} from "@orgos/protocol";
import { eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/agent/prompt";
import { scheduler } from "@/agent/scheduler";
import { RunSession } from "@/agent/session";
import { availableTools } from "@/agent/tools";
import type { ToolScope } from "@/agent/tools/tool";
import { db } from "@/db";
import {
	agents,
	conversationMembers,
	conversations,
	memoryItems,
	notes,
	orgUnits,
	principals,
	workItems,
} from "@/db/schema";
import { scoped } from "@/db/scope";
import { searchMemory } from "@/memory/search";
import { writeItem } from "@/memory/store";
import { drainMemoryJobs } from "@/memory/worker";
import { findAgent } from "@/services/agents";
import { unitContextOf } from "@/services/units";
import { actions, eventsOf, messagesBy, openDm, say } from "./agent-helpers";
import { type Client, createTeam, type TeamMember, uniq } from "./helpers";

let alice: TeamMember;
let bob: TeamMember;
let carol: TeamMember;
let dave: TeamMember;
let product: OrgUnit;
let rd: OrgUnit;

const s = () => scoped(alice.me.tenant.id);
const later = () => new Date(Date.now() + 11 * 60_000);

async function expectError(res: Response, status: number, code: string) {
	expect(res.status).toBe(status);
	expect(ErrorBodySchema.parse(await res.json()).error.code).toBe(code);
}

async function createUnit(
	c: Client,
	body: { name: string; handle: string; headId: string; parentId?: string },
): Promise<OrgUnit> {
	const res = await c.request("POST", "/api/org/units", body);
	expect(res.status).toBe(201);
	return OrgUnitResponseSchema.parse(await res.json()).unit;
}

async function openItems(c: Client): Promise<WorkItem[]> {
	const res = await c.request("GET", "/api/work-items?status=open");
	expect(res.status).toBe(200);
	return WorkItemListResponseSchema.parse(await res.json()).items;
}

async function conversationsOf(principalId: string) {
	const rows = await s().select(
		conversationMembers,
		eq(conversationMembers.principalId, principalId),
	);
	return s().select(
		conversations,
		inArray(
			conversations.id,
			rows.map((r) => r.conversationId),
		),
	);
}

beforeAll(async () => {
	[alice, bob, carol] = (await createTeam(["Alice", "Bob", "Carol"])) as [
		TeamMember,
		TeamMember,
		TeamMember,
	];
	[dave] = (await createTeam(["Dave"])) as [TeamMember];
	product = await createUnit(alice.client, {
		name: "产品部",
		handle: uniq("product"),
		headId: alice.me.principal.id,
	});
	const added = await alice.client.request(
		"POST",
		`/api/org/units/${product.unit.id}/members`,
		{ principalId: carol.me.principal.id },
	);
	expect(added.status).toBe(201);
	product = OrgUnitResponseSchema.parse(await added.json()).unit;
	const charter = await alice.client.request(
		"PATCH",
		`/api/org/units/${product.unit.id}`,
		{ charter: "排期按路线图直接答复；插队需求问负责人。" },
	);
	expect(charter.status).toBe(200);
	rd = await createUnit(alice.client, {
		name: "研发部",
		handle: uniq("rd"),
		headId: bob.me.principal.id,
	});
	for (const note of [
		{
			title: "路线图（对外）",
			body: "结算页 10 月 31 日上线",
			visibility: "shared",
		},
		{
			title: "路线图（内部）",
			body: "结算页走查由成员负责",
			visibility: "unit",
		},
	]) {
		const res = await carol.client.request(
			"POST",
			`/api/org/units/${product.unit.id}/notes`,
			note,
		);
		expect(res.status).toBe(201);
	}
});

describe("数据约束", () => {
	const insertPrincipal = (values: {
		kind: "human" | "agent" | "unit";
		userId: string | null;
		ownerId: string | null;
	}) =>
		s().insert(principals, {
			...values,
			handle: uniq("x"),
			displayName: "非法",
		});

	it("principals 的身份约束三分支在数据库层生效", async () => {
		const userId = alice.me.user.id;
		const someone = alice.me.principal.id;
		for (const bad of [
			{ kind: "unit" as const, userId, ownerId: null },
			{ kind: "unit" as const, userId: null, ownerId: someone },
			{ kind: "human" as const, userId: null, ownerId: null },
			{ kind: "agent" as const, userId: null, ownerId: null },
			{ kind: "agent" as const, userId, ownerId: someone },
		]) {
			await expect(insertPrincipal(bad)).rejects.toThrow();
		}
		const ok = await insertPrincipal({
			kind: "unit",
			userId: null,
			ownerId: null,
		});
		expect(ok.kind).toBe("unit");
	});
});

describe("单元树与权限", () => {
	it("建单元：同时建出单元分身与单元群（成员 = 分身 + 负责人及其分身）", async () => {
		expect(product.twin.displayName).toBe("产品部的分身");
		expect(product.twin.handle).toBe(`${product.unit.handle}-twin`);
		expect(product.twin.ownerId).toBe(product.unit.id);
		expect(product.head.id).toBe(alice.me.principal.id);
		const agent = await s().first(
			agents,
			eq(agents.principalId, product.twin.id),
		);
		expect(agent?.role).toBe("front");
		const groupId = product.groupId ?? "";
		const members = (
			await s().select(
				conversationMembers,
				eq(conversationMembers.conversationId, groupId),
			)
		).map((m) => m.principalId);
		const twinOf = (m: TeamMember) =>
			m.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
		expect(members.sort()).toEqual(
			[
				product.twin.id,
				alice.me.principal.id,
				twinOf(alice),
				carol.me.principal.id,
				twinOf(carol),
			].sort(),
		);
	});

	it("非租户 owner 建单元 → 403；改名 → 403；负责人可以改章程", async () => {
		await expectError(
			await bob.client.request("POST", "/api/org/units", {
				name: "销售部",
				handle: uniq("sales"),
				headId: bob.me.principal.id,
			}),
			403,
			"FORBIDDEN",
		);
		await expectError(
			await bob.client.request("PATCH", `/api/org/units/${rd.unit.id}`, {
				name: "改名",
			}),
			403,
			"FORBIDDEN",
		);
		await expectError(
			await carol.client.request("PATCH", `/api/org/units/${product.unit.id}`, {
				charter: "成员不能改",
			}),
			403,
			"FORBIDDEN",
		);
		const res = await bob.client.request(
			"PATCH",
			`/api/org/units/${rd.unit.id}`,
			{
				charter: "联调时间可以直接约。",
			},
		);
		expect(res.status).toBe(200);
		expect(OrgUnitResponseSchema.parse(await res.json()).unit.charter).toBe(
			"联调时间可以直接约。",
		);
	});

	it("别的租户看不到单元：列表里没有，单元页 404", async () => {
		const res = await dave.client.request("GET", "/api/org");
		const { units } = OrgResponseSchema.parse(await res.json());
		expect(units.some((u) => u.unit.id === product.unit.id)).toBe(false);
		expect(
			(await dave.client.request("GET", `/api/org/units/${product.unit.id}`))
				.status,
		).toBe(404);
	});

	it("成员变动同步单元群：移出成员连同其分身离开；单元群不能在群里直接加减人", async () => {
		const groupId = rd.groupId ?? "";
		const add = await bob.client.request(
			"POST",
			`/api/org/units/${rd.unit.id}/members`,
			{
				principalId: carol.me.principal.id,
			},
		);
		expect(add.status).toBe(201);
		const inGroup = async () =>
			(
				await s().select(
					conversationMembers,
					eq(conversationMembers.conversationId, groupId),
				)
			).map((m) => m.principalId);
		expect(await inGroup()).toContain(carol.me.principal.id);
		await expectError(
			await bob.client.request(
				"POST",
				`/api/conversations/${groupId}/members`,
				{
					principalId: alice.me.principal.id,
				},
			),
			400,
			"BAD_REQUEST",
		);
		const del = await bob.client.request(
			"DELETE",
			`/api/org/units/${rd.unit.id}/members/${carol.me.principal.id}`,
		);
		expect(del.status).toBe(204);
		const carolTwin =
			carol.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
		const left = await inGroup();
		expect(left).not.toContain(carol.me.principal.id);
		expect(left).not.toContain(carolTwin);
	});

	it("单元资料：非成员不能新增（403），成员不能改（403），负责人可以改", async () => {
		await expectError(
			await bob.client.request(
				"POST",
				`/api/org/units/${product.unit.id}/notes`,
				{
					title: "x",
					body: "y",
				},
			),
			403,
			"FORBIDDEN",
		);
		const detail = UnitDetailResponseSchema.parse(
			await (
				await alice.client.request("GET", `/api/org/units/${product.unit.id}`)
			).json(),
		);
		const note = detail.notes[0];
		if (!note) throw new Error("缺少单元资料");
		await expectError(
			await carol.client.request(
				"PATCH",
				`/api/org/units/${product.unit.id}/notes/${note.id}`,
				{ title: "成员改" },
			),
			403,
			"FORBIDDEN",
		);
		const ok = await alice.client.request(
			"PATCH",
			`/api/org/units/${product.unit.id}/notes/${note.id}`,
			{ title: note.title },
		);
		expect(ok.status).toBe(200);
	});

	it("单元页：成员看得到 unit 级资料，非成员只看得到 shared", async () => {
		const view = async (c: Client) =>
			UnitDetailResponseSchema.parse(
				await (
					await c.request("GET", `/api/org/units/${product.unit.id}`)
				).json(),
			);
		const member = await view(carol.client);
		const outsider = await view(bob.client);
		expect(member.myRole).toBe("member");
		expect(outsider.myRole).toBeNull();
		expect(member.notes.map((n) => n.title).sort()).toEqual([
			"路线图（内部）",
			"路线图（对外）",
		]);
		expect(outsider.notes.map((n) => n.title)).toEqual(["路线图（对外）"]);
	});
});

describe("问部门：与单元分身私聊", () => {
	let bobDm: string;
	let carolDm: string;

	beforeAll(async () => {
		bobDm = await openDm(bob.client, product.twin.id);
		carolDm = await openDm(carol.client, product.twin.id);
	});

	it("任何人都能与单元分身建私聊（AGENT_NOT_REACHABLE 的例外），成员只有提问人与单元分身", async () => {
		const members = (
			await s().select(
				conversationMembers,
				eq(conversationMembers.conversationId, bobDm),
			)
		).map((m) => m.principalId);
		expect(members.sort()).toEqual(
			[bob.me.principal.id, product.twin.id].sort(),
		);
		const aliceTwin =
			alice.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
		await expectError(
			await bob.client.request("POST", "/api/conversations", {
				kind: "dm",
				withPrincipalId: aliceTwin,
			}),
			400,
			"AGENT_NOT_REACHABLE",
		);
	});

	it("总是回应、为提问人办事：非成员只检索到 shared 单元资料，成员也检索到 unit 级", async () => {
		await say(bob.client, bobDm, "#note 路线图");
		const toBob = messagesBy(
			await eventsOf(bob.client, bobDm),
			product.twin.id,
		).at(-1);
		expect(toBob?.payload.text).toContain("路线图（对外）");
		expect(toBob?.payload.text).not.toContain("路线图（内部）");
		expect(toBob?.payload.askedById).toBe(bob.me.principal.id);
		expect(toBob?.onBehalfOfId).toBe(product.unit.id);

		await say(carol.client, carolDm, "#note 路线图");
		const toCarol = messagesBy(
			await eventsOf(carol.client, carolDm),
			product.twin.id,
		).at(-1);
		expect(toCarol?.payload.text).toContain("路线图（内部）");
	});

	it("章程内：record_decision 写单元资料（unit，作者为分身）与一条 subject=单元、scope=unit 的 decision 记忆", async () => {
		await say(bob.client, bobDm, "#decide 灰度比例定为 10%|结算页按 10% 灰度");
		const note = await s().first(
			notes,
			eq(notes.ownerId, product.unit.id),
			eq(notes.title, "灰度比例定为 10%"),
		);
		expect(note).toMatchObject({
			visibility: "unit",
			authorId: product.twin.id,
		});
		const item = (
			await s().select(
				memoryItems,
				eq(memoryItems.subjectId, product.unit.id),
				eq(memoryItems.kind, "decision"),
			)
		).find((i) =>
			i.sources.some((x) => x.kind === "note" && x.id === note?.id),
		);
		expect(item?.scope).toEqual({ kind: "unit", unitId: product.unit.id });
		const detail = UnitDetailResponseSchema.parse(
			await (
				await carol.client.request("GET", `/api/org/units/${product.unit.id}`)
			).json(),
		);
		expect(detail.decisions.map((d) => d.title)).toContain("灰度比例定为 10%");
	});

	it("章程外：上报交给负责人；负责人答复并存为资料后，分身在原私聊转告，答复存为单元资料并写 subject=单元的决定", async () => {
		const before = (await openItems(alice.client)).length;
		await say(bob.client, bobDm, "#escalate 能否插队需求 X");
		const items = await openItems(alice.client);
		expect(items).toHaveLength(before + 1);
		const item = items[0];
		expect(item).toMatchObject({
			kind: "decision",
			ownerId: alice.me.principal.id,
			requesterId: bob.me.principal.id,
			conversationId: bobDm,
		});
		const created = (await eventsOf(bob.client, bobDm)).findLast(
			(e) => e.type === "escalation.created",
		);
		expect(created?.actorId).toBe(product.twin.id);
		const res = await alice.client.request(
			"POST",
			`/api/work-items/${item?.id}/resolve`,
			{ action: "answer", text: "不能插队，排到 11 月", saveAsNote: true },
		);
		expect(res.status).toBe(200);
		await scheduler.idle(bobDm);
		const reply = messagesBy(
			await eventsOf(bob.client, bobDm),
			product.twin.id,
		).at(-1);
		expect(reply?.payload.text).toBe("本人答复：不能插队，排到 11 月");
		const saved = await s().first(
			notes,
			eq(notes.ownerId, product.unit.id),
			eq(notes.authorId, alice.me.principal.id),
		);
		expect(saved?.visibility).toBe("unit");
		await drainMemoryJobs(s(), { now: new Date() });
		const decided = await s().select(
			memoryItems,
			eq(memoryItems.subjectId, product.unit.id),
			eq(memoryItems.kind, "decision"),
		);
		expect(decided.some((d) => d.content.includes("不能插队"))).toBe(true);
	});

	it("硬边界：单元分身读不到成员的私有资料", async () => {
		const res = await alice.client.request("POST", "/api/notes", {
			title: "私事",
			body: "下周三请假看牙",
			visibility: "private",
		});
		expect(res.status).toBe(201);
		await say(carol.client, carolDm, "#note 看牙");
		const reply = messagesBy(
			await eventsOf(carol.client, carolDm),
			product.twin.id,
		).at(-1);
		expect(reply?.payload.text).toContain("无结果");
		const own = await searchMemory(
			s(),
			{ ownerId: product.unit.id, requesterId: null },
			{ query: "看牙" },
		);
		expect(own.lines).toEqual([]);
	});

	it("硬边界：单元分身不在任何人之间的私聊里", async () => {
		await openDm(alice.client, bob.me.principal.id);
		const convs = await conversationsOf(product.twin.id);
		for (const c of convs) {
			const members = await s().select(
				conversationMembers,
				eq(conversationMembers.conversationId, c.id),
			);
			const humans = await s().select(
				principals,
				inArray(
					principals.id,
					members.map((m) => m.principalId),
				),
				eq(principals.kind, "human"),
			);
			if (c.kind === "dm") expect(humans).toHaveLength(1);
		}
	});
});

describe("章程进单元分身的系统提示", () => {
	it("系统提示里有章程、负责人与提问人是否成员；有 record_decision，没有交办与应用接口", async () => {
		const agent = await findAgent(s(), { id: product.twin.id });
		const owner = await s().first(
			principals,
			eq(principals.id, product.unit.id),
		);
		if (!agent || !owner) throw new Error("缺少单元分身");
		const scope = {
			s: s(),
			agent,
			owner,
			unit: await unitContextOf(s(), owner, bob.me.principal.id),
			conversation: { id: "c", kind: "dm" as const, topicId: "t" },
			runId: "r",
			actingFor: { kind: "other" as const, principalId: bob.me.principal.id },
			depth: 0,
			triggerEventId: null,
			session: new RunSession(),
			teammates: [],
			delegate: () => Promise.resolve({ outcome: "returned" as const }),
			startNegotiation: () => {},
		} satisfies ToolScope;
		const tools = availableTools(scope);
		const names = tools.map((t) => t.name);
		expect(names).toContain("record_decision");
		expect(names).toContain("escalate_to_owner");
		expect(names).not.toContain("delegate_to_teammate");
		expect(names).not.toContain("negotiate");
		expect(names).not.toContain("app_api_search");
		expect(names).not.toContain("app_api_call");
		const prompt = buildSystemPrompt({
			scope,
			tools,
			requesterName: "Bob",
			conversationTitle: null,
			topicTitle: null,
			delegatedBy: null,
			resume: null,
		});
		expect(prompt).toContain("排期按路线图直接答复；插队需求问负责人。");
		expect(prompt).toContain("Bob不是产品部的成员");
		expect(prompt).toContain("转给负责人Alice");
		expect(prompt).toContain("不提供按人统计的活动数据");
	});
});

describe("单元群 @ 规则", () => {
	it("不 @ 单元分身时它不开口；@ 了才回应", async () => {
		const groupId = product.groupId ?? "";
		await say(carol.client, groupId, "#note 路线图");
		let events = await eventsOf(carol.client, groupId);
		expect(messagesBy(events, product.twin.id)).toHaveLength(0);
		await say(carol.client, groupId, "#note 路线图", {
			mentions: [product.twin.id],
		});
		events = await eventsOf(carol.client, groupId);
		expect(messagesBy(events, product.twin.id)).toHaveLength(1);
	});

	it("单元群的材料能提炼出 subject = 单元、scope = unit 的条目", async () => {
		const groupId = product.groupId ?? "";
		await say(
			carol.client,
			groupId,
			`#fact:${product.unit.handle} 决定与口径|产品部周会改到周三上午`,
		);
		await drainMemoryJobs(s(), { now: later() });
		const item = await s().first(
			memoryItems,
			eq(memoryItems.subjectId, product.unit.id),
			eq(memoryItems.content, "产品部周会改到周三上午"),
		);
		expect(item?.scope).toEqual({ kind: "unit", unitId: product.unit.id });
	});
});

describe("unit 范围的第三人规则", () => {
	it("unit 条目给非成员时抹去成员姓名、出处写“来自与同事的交流”；给成员时原样", async () => {
		await s().transaction((tx) =>
			writeItem(tx, {
				subjectId: product.unit.id,
				kind: "fact",
				category: "人员与分工",
				content: "Carol 负责结算页走查清单",
				entities: [],
				scope: { kind: "unit", unitId: product.unit.id },
				sources: [],
				confidence: 1,
			}),
		);
		const outsider = await searchMemory(
			s(),
			{ ownerId: product.unit.id, requesterId: bob.me.principal.id },
			{ query: "走查清单" },
		);
		const line = outsider.lines.find((l) => l.includes("走查清单"));
		expect(line).toContain("来自与同事的交流");
		expect(line).not.toContain("Carol");
		const member = await searchMemory(
			s(),
			{ ownerId: product.unit.id, requesterId: carol.me.principal.id },
			{ query: "走查清单" },
		);
		expect(member.lines.find((l) => l.includes("走查清单"))).toContain("Carol");
	});
});

describe("与单元协商", () => {
	const negotiationOf = async (dmId: string) => {
		const started = (await eventsOf(bob.client, dmId)).findLast(
			(e) => e.type === "negotiation.started",
		);
		if (started?.type !== "negotiation.started")
			throw new Error("没有协商卡片");
		await scheduler.idle(started.payload.negotiationConversationId);
		return started.payload.negotiationConversationId;
	};

	it("单元与单元：两个单元分身谈妥，观察者是两位负责人，确认待办给负责人", async () => {
		const carolDm = await openDm(carol.client, product.twin.id);
		await say(carol.client, carolDm, `#negotiate:${rd.unit.handle} 约联调时间`);
		const heads = await openDm(alice.client, bob.me.principal.id);
		const negotiationId = await negotiationOf(heads);
		const members = await s().select(
			conversationMembers,
			eq(conversationMembers.conversationId, negotiationId),
		);
		const role = (id: string) =>
			members.find((m) => m.principalId === id)?.role;
		expect(role(product.twin.id)).toBe("member");
		expect(role(rd.twin.id)).toBe("member");
		expect(role(alice.me.principal.id)).toBe("observer");
		expect(role(bob.me.principal.id)).toBe("observer");
		const ended = (await eventsOf(alice.client, negotiationId)).find(
			(e) => e.type === "negotiation.ended",
		);
		expect(ended?.payload).toMatchObject({ outcome: "agreed" });
		const confirmations = await s().select(
			workItems,
			eq(workItems.kind, "confirmation"),
		);
		const owners = confirmations
			.filter(
				(w) =>
					(w.payload as { negotiationConversationId?: string })
						.negotiationConversationId === negotiationId,
			)
			.map((w) => w.ownerId);
		expect(owners.sort()).toEqual(
			[alice.me.principal.id, bob.me.principal.id].sort(),
		);
	});

	it("个人与单元：need_owner 交给单元负责人", async () => {
		const aliceTwin =
			alice.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
		const ownDm = await openDm(alice.client, aliceTwin);
		const before = (await openItems(bob.client)).length;
		await say(
			alice.client,
			ownDm,
			`#negotiate:${rd.unit.handle} 约评审 #needowner`,
		);
		const heads = await openDm(alice.client, bob.me.principal.id);
		await negotiationOf(heads);
		const items = await openItems(bob.client);
		expect(items).toHaveLength(before + 1);
		expect(items[0]?.kind).toBe("decision");
		const card = (await eventsOf(bob.client, heads)).findLast(
			(e) => e.type === "escalation.created",
		);
		expect(card?.actorId).toBe(rd.twin.id);
	});

	it("非成员不能以单元名义发起协商（工具不可用）", async () => {
		const bobDm = await openDm(bob.client, product.twin.id);
		await say(bob.client, bobDm, `#negotiate:${rd.unit.handle} 约联调`);
		const last = actions(await eventsOf(bob.client, bobDm)).at(-1);
		expect(last?.payload).toMatchObject({ tool: "negotiate", ok: false });
	});
});

describe("负责人管理单元记忆与代答记录", () => {
	it("负责人拿得到单元代答记录与单元条目；成员与非成员 403", async () => {
		const res = await alice.client.request(
			"GET",
			`/api/memory/answers?unitId=${product.unit.id}`,
		);
		expect(res.status).toBe(200);
		const { items } = TwinAnswerListResponseSchema.parse(await res.json());
		expect(items.length).toBeGreaterThan(0);
		expect(items.every((a) => a.answer.actorId === product.twin.id)).toBe(true);
		for (const other of [carol, bob]) {
			await expectError(
				await other.client.request(
					"GET",
					`/api/memory/answers?unitId=${product.unit.id}`,
				),
				403,
				"FORBIDDEN",
			);
		}
		const own = await alice.client.request(
			"GET",
			`/api/memory/items?unitId=${product.unit.id}`,
		);
		expect(own.status).toBe(200);
		const listed = (await own.json()) as { items: { subjectId: string }[] };
		expect(listed.items.length).toBeGreaterThan(0);
		expect(listed.items.every((i) => i.subjectId === product.unit.id)).toBe(
			true,
		);
		const mine = await alice.client.request("GET", "/api/memory/answers");
		const personal = TwinAnswerListResponseSchema.parse(await mine.json());
		expect(
			personal.items.some((a) => a.answer.actorId === product.twin.id),
		).toBe(false);
	});

	it("负责人管理单元的对外政策（类别授权）", async () => {
		const res = await alice.client.request(
			"PUT",
			`/api/memory/disclosure?unitId=${product.unit.id}`,
			{ category: "人员与分工", allowed: false },
		);
		expect(res.status).toBe(200);
		const outsider = await searchMemory(
			s(),
			{ ownerId: product.unit.id, requesterId: bob.me.principal.id },
			{ query: "走查清单" },
		);
		expect(outsider.lines.some((l) => l.includes("走查清单"))).toBe(false);
		await expectError(
			await carol.client.request(
				"PUT",
				`/api/memory/disclosure?unitId=${product.unit.id}`,
				{ category: "人员与分工", allowed: true },
			),
			403,
			"FORBIDDEN",
		);
	});
});

describe("迁移 0006 可重复执行", () => {
	it("整份迁移再执行两遍不报错，已有数据与约束仍在", async () => {
		const file = path.resolve(
			fileURLToPath(new URL("./", import.meta.url)),
			"../drizzle/0006_org_units.sql",
		);
		const statements = readFileSync(file, "utf8")
			.split("--> statement-breakpoint")
			.map((x) => x.trim())
			.filter(Boolean);
		for (let i = 0; i < 2; i++)
			for (const stmt of statements) await db.execute(sql.raw(stmt));
		expect(
			(await s().select(orgUnits, eq(orgUnits.principalId, product.unit.id)))
				.length,
		).toBe(1);
		await expect(
			s().insert(principals, {
				kind: "unit",
				userId: alice.me.user.id,
				ownerId: null,
				handle: uniq("x"),
				displayName: "非法",
			}),
		).rejects.toThrow();
	});
});
