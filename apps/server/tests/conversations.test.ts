/**
 * 集成：会话、成员、消息、已读（真实 Postgres + 进程内 Hono app）。
 */
import {
	ConversationListResponseSchema,
	CreateConversationResponseSchema,
	ErrorBodySchema,
	EventsResponseSchema,
	formatOf,
	MESSAGE_MAX_LENGTH,
	PostMessageResponseSchema,
} from "@orgos/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymous, type Client, createTeam, type TeamMember } from "./helpers";

async function expectError(res: Response, status: number, code: string) {
	expect(res.status).toBe(status);
	const body = ErrorBodySchema.parse(await res.json());
	expect(body.error.code).toBe(code);
}

async function dm(c: Client, withPrincipalId: string, status = 201) {
	const res = await c.request("POST", "/api/conversations", {
		kind: "dm",
		withPrincipalId,
	});
	expect(res.status).toBe(status);
	return CreateConversationResponseSchema.parse(await res.json()).conversation;
}

async function say(
	c: Client,
	conversationId: string,
	text: string,
	mentions?: string[],
) {
	const res = await c.request(
		"POST",
		`/api/conversations/${conversationId}/messages`,
		{ text, ...(mentions ? { mentions } : {}) },
	);
	expect(res.status).toBe(201);
	return PostMessageResponseSchema.parse(await res.json()).event;
}

async function eventsOf(c: Client, conversationId: string, query = "") {
	const res = await c.request(
		"GET",
		`/api/conversations/${conversationId}/events${query}`,
	);
	expect(res.status).toBe(200);
	return EventsResponseSchema.parse(await res.json()).items;
}

async function listOf(c: Client) {
	const res = await c.request("GET", "/api/conversations");
	expect(res.status).toBe(200);
	return ConversationListResponseSchema.parse(await res.json()).items;
}

let alice: TeamMember;
let bob: TeamMember;
let carol: TeamMember;
let dave: TeamMember;

function agentOf(m: TeamMember, role: "front" | "specialist") {
	const agent = m.me.agents.find((a) => a.role === role);
	if (!agent) throw new Error(`${m.me.principal.handle} 缺少 ${role} 代理`);
	return agent.principal;
}
const twinOf = (m: TeamMember) => agentOf(m, "front");
const opsOf = (m: TeamMember) => agentOf(m, "specialist");

beforeAll(async () => {
	[alice, bob, carol] = (await createTeam(["Alice", "Bob", "Carol"])) as [
		TeamMember,
		TeamMember,
		TeamMember,
	];
	[dave] = (await createTeam(["Dave"])) as [TeamMember];
});

describe("未登录", () => {
	it.each([
		["GET", "/api/conversations"],
		["POST", "/api/conversations"],
		["GET", "/api/conversations/00000000-0000-4000-8000-000000000000/events"],
		[
			"POST",
			"/api/conversations/00000000-0000-4000-8000-000000000000/messages",
		],
	])("%s %s → 401", async (method, path) => {
		await expectError(
			await anonymous.request(method, path, method === "POST" ? {} : undefined),
			401,
			"UNAUTHORIZED",
		);
	});
});

describe("私聊", () => {
	it("同一对人重复建 dm 返回已有会话（200），反方向也一样", async () => {
		const first = await dm(alice.client, bob.me.principal.id, 201);
		expect(first.kind).toBe("dm");
		expect(first.lastSeq).toBe(0);
		const again = await dm(alice.client, bob.me.principal.id, 200);
		expect(again.id).toBe(first.id);
		const reverse = await dm(bob.client, alice.me.principal.id, 200);
		expect(reverse.id).toBe(first.id);
	});

	it("并发建同一对 dm 只产生一个会话", async () => {
		const results = await Promise.all(
			Array.from({ length: 6 }, () =>
				alice.client.request("POST", "/api/conversations", {
					kind: "dm",
					withPrincipalId: carol.me.principal.id,
				}),
			),
		);
		const statuses = results.map((r) => r.status).sort();
		expect(statuses).toEqual([200, 200, 200, 200, 200, 201]);
		const ids = await Promise.all(
			results.map(
				async (r) =>
					CreateConversationResponseSchema.parse(await r.json()).conversation
						.id,
			),
		);
		expect(new Set(ids).size).toBe(1);
	});

	it("两个真人的私聊：同事务加入双方分身；和自己的代理私聊只有两人", async () => {
		const conv = await dm(carol.client, bob.me.principal.id);
		const listed = (await listOf(bob.client)).find(
			(x) => x.conversation.id === conv.id,
		);
		expect(listed?.members.map((m) => m.id).sort()).toEqual(
			[
				carol.me.principal.id,
				bob.me.principal.id,
				twinOf(carol).id,
				twinOf(bob).id,
			].sort(),
		);

		const own = await dm(carol.client, twinOf(carol).id);
		expect(own.id).not.toBe(conv.id);
		const ownListed = (await listOf(carol.client)).find(
			(x) => x.conversation.id === own.id,
		);
		expect(ownListed?.members.map((m) => m.id).sort()).toEqual(
			[carol.me.principal.id, twinOf(carol).id].sort(),
		);
		expect((await dm(carol.client, twinOf(carol).id, 200)).id).toBe(own.id);
		await dm(carol.client, opsOf(carol).id);
	});

	it("单独找他人的任何代理（分身或助手）→ 400 AGENT_NOT_REACHABLE", async () => {
		for (const id of [twinOf(bob).id, opsOf(bob).id]) {
			await expectError(
				await alice.client.request("POST", "/api/conversations", {
					kind: "dm",
					withPrincipalId: id,
				}),
				400,
				"AGENT_NOT_REACHABLE",
			);
		}
	});

	it("和自己建私聊 → 400", async () => {
		await expectError(
			await alice.client.request("POST", "/api/conversations", {
				kind: "dm",
				withPrincipalId: alice.me.principal.id,
			}),
			400,
			"BAD_REQUEST",
		);
	});

	it("其他租户的人或代理 → 404", async () => {
		for (const id of [dave.me.principal.id, twinOf(dave).id]) {
			await expectError(
				await alice.client.request("POST", "/api/conversations", {
					kind: "dm",
					withPrincipalId: id,
				}),
				404,
				"NOT_FOUND",
			);
		}
		await expectError(
			await dave.client.request("POST", "/api/conversations", {
				kind: "dm",
				withPrincipalId: twinOf(alice).id,
			}),
			404,
			"NOT_FOUND",
		);
	});

	it("参数不合法 → 400", async () => {
		for (const body of [
			{ kind: "dm", withPrincipalId: "not-a-uuid" },
			{ kind: "dm" },
			{ kind: "negotiation" },
			{ kind: "group", title: "   ", memberIds: [] },
		]) {
			await expectError(
				await alice.client.request("POST", "/api/conversations", body),
				400,
				"BAD_REQUEST",
			);
		}
	});
});

describe("消息与事件", () => {
	let convId: string;
	let ann: TeamMember;
	let ben: TeamMember;
	beforeAll(async () => {
		[ann, ben] = (await createTeam(["Ann", "Ben"])) as [TeamMember, TeamMember];
		convId = (await dm(ann.client, ben.me.principal.id)).id;
	});

	it("发消息得到 seq 递增的 message.posted，拉取按 seq 升序", async () => {
		const e1 = await say(ann.client, convId, "早上好");
		const e2 = await say(ben.client, convId, "早", [ann.me.principal.id]);
		expect(e1).toMatchObject({
			type: "message.posted",
			seq: 1,
			conversationId: convId,
			actorId: ann.me.principal.id,
			onBehalfOfId: null,
			payload: { text: "早上好", mentions: [] },
		});
		expect(e2.seq).toBe(2);
		expect(e2.payload).toEqual({ text: "早", mentions: [ann.me.principal.id] });

		const all = await eventsOf(ben.client, convId);
		expect(all.map((e) => e.seq)).toEqual([1, 2]);
		expect(await eventsOf(ben.client, convId, "?after=1")).toHaveLength(1);
		expect(await eventsOf(ben.client, convId, "?after=2")).toEqual([]);
		expect(await eventsOf(ben.client, convId, "?limit=1")).toHaveLength(1);
	});

	it("events 查询参数不合法 → 400", async () => {
		for (const q of ["?limit=0", "?limit=201", "?after=-1", "?after=abc"]) {
			await expectError(
				await ann.client.request(
					"GET",
					`/api/conversations/${convId}/events${q}`,
				),
				400,
				"BAD_REQUEST",
			);
		}
	});

	it("空消息、纯空白、超 8000 字 → 400；恰好 8000 字可以", async () => {
		for (const text of ["", "  \n\t ", "x".repeat(MESSAGE_MAX_LENGTH + 1)]) {
			await expectError(
				await ann.client.request(
					"POST",
					`/api/conversations/${convId}/messages`,
					{
						text,
					},
				),
				400,
				"BAD_REQUEST",
			);
		}
		await say(ann.client, convId, "x".repeat(MESSAGE_MAX_LENGTH));
	});

	it("@ 非会话成员 → 400", async () => {
		await expectError(
			await ann.client.request(
				"POST",
				`/api/conversations/${convId}/messages`,
				{
					text: "hi",
					mentions: [opsOf(ann).id],
				},
			),
			400,
			"BAD_REQUEST",
		);
	});

	it("消息格式：缺省为 text；人可以发 md；人直接发 html → 400", async () => {
		const [xia, yan] = (await createTeam(["Xia", "Yan"])) as [
			TeamMember,
			TeamMember,
		];
		const convId = (await dm(xia.client, yan.me.principal.id)).id;
		const plain = await say(xia.client, convId, "**原样**");
		if (plain.type !== "message.posted") throw new Error(plain.type);
		expect(plain.payload).toEqual({ text: "**原样**", mentions: [] });
		expect(formatOf(plain.payload)).toBe("text");

		const res = await xia.client.request(
			"POST",
			`/api/conversations/${convId}/messages`,
			{ text: "**加粗**", format: "md" },
		);
		expect(res.status).toBe(201);
		const { event } = PostMessageResponseSchema.parse(await res.json());
		expect(event.payload).toMatchObject({ text: "**加粗**", format: "md" });

		const before = (await eventsOf(xia.client, convId)).length;
		await expectError(
			await xia.client.request(
				"POST",
				`/api/conversations/${convId}/messages`,
				{ text: "<b>网页</b>", format: "html" },
			),
			400,
			"BAD_REQUEST",
		);
		await expectError(
			await xia.client.request(
				"POST",
				`/api/conversations/${convId}/messages`,
				{ text: "x", format: "rtf" },
			),
			400,
			"BAD_REQUEST",
		);
		expect(await eventsOf(xia.client, convId)).toHaveLength(before);
	});

	it("20 个并发发送：seq 连续不重不缺", async () => {
		const before = (await eventsOf(ann.client, convId)).length;
		const sent = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				say(i % 2 ? ann.client : ben.client, convId, `并发 ${i}`),
			),
		);
		const seqs = sent.map((e) => e.seq as number).sort((x, y) => x - y);
		expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => before + 1 + i));
		const all = await eventsOf(ann.client, convId, "?limit=200");
		expect(all.map((e) => e.seq)).toEqual(
			Array.from({ length: before + 20 }, (_, i) => i + 1),
		);
		const list = await listOf(ann.client);
		expect(
			list.find((x) => x.conversation.id === convId)?.conversation.lastSeq,
		).toBe(before + 20);
	});

	it("列表带成员、最后一条事件与未读数；已读后清零", async () => {
		const [item] = (await listOf(ben.client)).filter(
			(x) => x.conversation.id === convId,
		);
		expect(item).toBeDefined();
		expect(item?.members.map((m) => m.id).sort()).toEqual(
			[
				ann.me.principal.id,
				ben.me.principal.id,
				twinOf(ann).id,
				twinOf(ben).id,
			].sort(),
		);
		expect(item?.lastEvent?.seq).toBe(item?.conversation.lastSeq);
		// ben 未读 = ann 发的消息数（前 1 条 + 8000 字 1 条 + 并发中 10 条）。
		expect(item?.unread).toBe(12);
		expect(item?.lastReadSeq).toBe(0);

		const lastSeq = item?.conversation.lastSeq as number;
		const read = await ben.client.request(
			"POST",
			`/api/conversations/${convId}/read`,
			{
				seq: lastSeq,
			},
		);
		expect(read.status).toBe(204);
		const after = (await listOf(ben.client)).find(
			(x) => x.conversation.id === convId,
		);
		expect(after?.unread).toBe(0);
		expect(after?.lastReadSeq).toBe(lastSeq);

		// 已读只前进不后退。
		await ben.client.request("POST", `/api/conversations/${convId}/read`, {
			seq: 1,
		});
		expect(
			(await listOf(ben.client)).find((x) => x.conversation.id === convId)
				?.lastReadSeq,
		).toBe(lastSeq);

		await expectError(
			await ben.client.request("POST", `/api/conversations/${convId}/read`, {
				seq: lastSeq + 1,
			}),
			400,
			"BAD_REQUEST",
		);
	});

	it("列表按最近活动倒序", async () => {
		const other = await dm(ann.client, twinOf(ann).id);
		await say(ann.client, other.id, "最新的一条");
		const [first] = await listOf(ann.client);
		expect(first?.conversation.id).toBe(other.id);
	});

	it("stop 对成员返回 204", async () => {
		const res = await ann.client.request(
			"POST",
			`/api/conversations/${convId}/stop`,
		);
		expect(res.status).toBe(204);
	});
});

describe("非成员与跨租户一律 404", () => {
	let convId: string;
	let outsider: TeamMember;
	let foreign: TeamMember;
	beforeAll(async () => {
		const [a, b, c] = (await createTeam(["Amy", "Bill", "Cid"])) as [
			TeamMember,
			TeamMember,
			TeamMember,
		];
		[foreign] = (await createTeam(["Dan"])) as [TeamMember];
		outsider = c;
		convId = (await dm(a.client, b.me.principal.id)).id;
		await say(a.client, convId, "只有我们俩能看");
	});

	it.each([
		["GET", "events", undefined],
		["POST", "messages", { text: "偷看" }],
		["POST", "read", { seq: 1 }],
		["POST", "stop", undefined],
		[
			"POST",
			"members",
			{ principalId: "00000000-0000-4000-8000-000000000000" },
		],
	])("%s %s", async (method, action, body) => {
		for (const who of [outsider, foreign]) {
			await expectError(
				await who.client.request(
					method,
					`/api/conversations/${convId}/${action}`,
					body,
				),
				404,
				"NOT_FOUND",
			);
		}
	});

	it("不存在的会话与非 uuid 的 id → 404", async () => {
		for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
			await expectError(
				await outsider.client.request("GET", `/api/conversations/${id}/events`),
				404,
				"NOT_FOUND",
			);
		}
	});

	it("非成员的会话列表里没有它", async () => {
		for (const who of [outsider, foreign]) {
			const list = await listOf(who.client);
			expect(list.some((x) => x.conversation.id === convId)).toBe(false);
		}
	});
});

describe("群聊", () => {
	let owner: TeamMember;
	let b: TeamMember;
	let c: TeamMember;
	let foreign: TeamMember;
	let groupId: string;

	beforeAll(async () => {
		[owner, b, c] = (await createTeam(["Olga", "Bert", "Cora"])) as [
			TeamMember,
			TeamMember,
			TeamMember,
		];
		[foreign] = (await createTeam(["Fred"])) as [TeamMember];
	});

	it("建群：成员含自己，每个人的分身随本人入群；被拉入的人各一条 member.joined", async () => {
		const res = await owner.client.request("POST", "/api/conversations", {
			kind: "group",
			title: "  Q4 发布  ",
			memberIds: [
				b.me.principal.id,
				twinOf(owner).id,
				owner.me.principal.id,
				b.me.principal.id,
				opsOf(owner).id,
			],
		});
		expect(res.status).toBe(201);
		const { conversation } = CreateConversationResponseSchema.parse(
			await res.json(),
		);
		groupId = conversation.id;
		expect(conversation.kind).toBe("group");
		expect(conversation.title).toBe("Q4 发布");
		expect(conversation.lastSeq).toBe(2);

		const events = await eventsOf(b.client, groupId);
		expect(events.map((e) => e.payload)).toEqual([
			{ principalId: b.me.principal.id },
			{ principalId: opsOf(owner).id },
		]);
		const item = (await listOf(b.client)).find(
			(x) => x.conversation.id === groupId,
		);
		expect(item?.members.map((m) => m.id).sort()).toEqual(
			[
				owner.me.principal.id,
				twinOf(owner).id,
				b.me.principal.id,
				twinOf(b).id,
				opsOf(owner).id,
			].sort(),
		);
		// member.joined 不计入未读。
		expect(item?.unread).toBe(0);
	});

	it("建群时拉他人助手、或只拉别人的分身不拉本人 → 400 AGENT_NOT_REACHABLE；拉外租户 → 404", async () => {
		for (const memberIds of [[opsOf(b).id], [twinOf(c).id]]) {
			await expectError(
				await owner.client.request("POST", "/api/conversations", {
					kind: "group",
					title: "x",
					memberIds,
				}),
				400,
				"AGENT_NOT_REACHABLE",
			);
		}
		await expectError(
			await owner.client.request("POST", "/api/conversations", {
				kind: "group",
				title: "x",
				memberIds: [foreign.me.principal.id],
			}),
			404,
			"NOT_FOUND",
		);
	});

	it("加人：其分身一起入群；他人助手 400；已在群里 409；外租户 404", async () => {
		const add = (who: TeamMember, principalId: string) =>
			who.client.request("POST", `/api/conversations/${groupId}/members`, {
				principalId,
			});
		expect((await add(b, c.me.principal.id)).status).toBe(201);
		const members = (await listOf(c.client)).find(
			(x) => x.conversation.id === groupId,
		)?.members;
		expect(members?.map((m) => m.id)).toEqual(
			expect.arrayContaining([c.me.principal.id, twinOf(c).id]),
		);
		await expectError(
			await add(owner, opsOf(c).id),
			400,
			"AGENT_NOT_REACHABLE",
		);
		for (const id of [c.me.principal.id, twinOf(b).id])
			await expectError(await add(owner, id), 409, "ALREADY_MEMBER");
		await expectError(
			await add(owner, foreign.me.principal.id),
			404,
			"NOT_FOUND",
		);
		const events = await eventsOf(c.client, groupId);
		expect(events.at(-1)).toMatchObject({
			type: "member.joined",
			actorId: b.me.principal.id,
			payload: { principalId: c.me.principal.id },
		});
	});

	it("退群：本人退出时分身一起退；分身不能单独移出；只有创建者能移出别人", async () => {
		const remove = (who: TeamMember, principalId: string) =>
			who.client.request(
				"DELETE",
				`/api/conversations/${groupId}/members/${principalId}`,
			);
		await expectError(await remove(c, twinOf(c).id), 400, "BAD_REQUEST");
		await expectError(await remove(c, b.me.principal.id), 403, "FORBIDDEN");
		expect((await remove(c, c.me.principal.id)).status).toBe(204);
		const members = (await listOf(owner.client))
			.find((x) => x.conversation.id === groupId)
			?.members.map((m) => m.id);
		expect(members).not.toContain(c.me.principal.id);
		expect(members).not.toContain(twinOf(c).id);
		expect(
			(await listOf(c.client)).map((x) => x.conversation.id),
		).not.toContain(groupId);
		// 创建者移出别人，自己的助手自己移出。
		expect((await remove(owner, b.me.principal.id)).status).toBe(204);
		expect((await remove(owner, opsOf(owner).id)).status).toBe(204);
		const events = await eventsOf(owner.client, groupId);
		expect(
			events.filter((e) => e.type === "member.left").map((e) => e.payload),
		).toEqual([
			{ principalId: c.me.principal.id },
			{ principalId: b.me.principal.id },
			{ principalId: opsOf(owner).id },
		]);
		expect(
			(await listOf(owner.client))
				.find((x) => x.conversation.id === groupId)
				?.members.map((m) => m.id)
				.sort(),
		).toEqual([owner.me.principal.id, twinOf(owner).id].sort());
	});

	it("私聊不能加成员 → 400", async () => {
		const conv = await dm(owner.client, b.me.principal.id);
		await expectError(
			await owner.client.request(
				"POST",
				`/api/conversations/${conv.id}/members`,
				{
					principalId: c.me.principal.id,
				},
			),
			400,
			"BAD_REQUEST",
		);
	});
});
