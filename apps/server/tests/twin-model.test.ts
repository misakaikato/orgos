/**
 * 集成：分身模型——在线状态与 presence 推送、问分身校验、协商卡片落在两人私聊。
 */
import {
	type BrowserFrame,
	ConversationListResponseSchema,
	CreateConversationResponseSchema,
	DirectoryResponseSchema,
	ErrorBodySchema,
	EventsResponseSchema,
	PostMessageResponseSchema,
	UpdateStatusResponseSchema,
	WorkItemListResponseSchema,
} from "@orgos/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { scoped } from "@/db/scope";
import { browserHub, type HubSocket } from "@/realtime/browser-hub";
import {
	appendNegotiationStep,
	endNegotiation,
	startNegotiation,
} from "@/services/negotiations";
import { anonymous, type Client, createTeam, type TeamMember } from "./helpers";

async function expectError(res: Response, status: number, code: string) {
	expect(res.status).toBe(status);
	const body = ErrorBodySchema.parse(await res.json());
	expect(body.error.code).toBe(code);
}

async function dm(c: Client, withPrincipalId: string) {
	const res = await c.request("POST", "/api/conversations", {
		kind: "dm",
		withPrincipalId,
	});
	expect([200, 201]).toContain(res.status);
	return CreateConversationResponseSchema.parse(await res.json()).conversation;
}

async function listOf(c: Client) {
	const res = await c.request("GET", "/api/conversations");
	expect(res.status).toBe(200);
	return ConversationListResponseSchema.parse(await res.json()).items;
}

async function eventsOf(c: Client, conversationId: string) {
	const res = await c.request(
		"GET",
		`/api/conversations/${conversationId}/events`,
	);
	expect(res.status).toBe(200);
	return EventsResponseSchema.parse(await res.json()).items;
}

function agentOf(m: TeamMember, role: "front" | "specialist") {
	const agent = m.me.agents.find((a) => a.role === role);
	if (!agent) throw new Error(`${m.me.principal.handle} 缺少 ${role} 代理`);
	return agent.principal;
}
const twinOf = (m: TeamMember) => agentOf(m, "front");

let alice: TeamMember;
let bob: TeamMember;
let carol: TeamMember;
let dave: TeamMember;

beforeAll(async () => {
	[alice, bob, carol] = (await createTeam(["Alice", "Bob", "Carol"])) as [
		TeamMember,
		TeamMember,
		TeamMember,
	];
	[dave] = (await createTeam(["Dave"])) as [TeamMember];
});

describe("在线状态", () => {
	const attached: [string, HubSocket][] = [];
	function listen(principalId: string): BrowserFrame[] {
		const frames: BrowserFrame[] = [];
		const sock: HubSocket = {
			send: (data) => frames.push(JSON.parse(data) as BrowserFrame),
			close: () => {},
		};
		browserHub.attach(principalId, sock);
		attached.push([principalId, sock]);
		return frames;
	}
	afterEach(() => {
		for (const [id, sock] of attached.splice(0)) browserHub.detach(id, sock);
	});

	it("PATCH /api/me/status：返回新状态，推给同租户每个人（含自己），外租户收不到", async () => {
		const toAlice = listen(alice.me.principal.id);
		const toBob = listen(bob.me.principal.id);
		const toDave = listen(dave.me.principal.id);

		const res = await alice.client.request("PATCH", "/api/me/status", {
			status: "busy",
		});
		expect(res.status).toBe(200);
		const { principal } = UpdateStatusResponseSchema.parse(await res.json());
		expect(principal).toMatchObject({
			id: alice.me.principal.id,
			status: "busy",
		});
		const frame = {
			t: "presence",
			principalId: alice.me.principal.id,
			status: "busy",
		};
		expect(toAlice).toEqual([frame]);
		expect(toBob).toEqual([frame]);
		expect(toDave).toEqual([]);

		const directory = DirectoryResponseSchema.parse(
			await (await bob.client.request("GET", "/api/directory")).json(),
		);
		const seen = directory.people.find(
			(p) => p.principal.id === alice.me.principal.id,
		);
		expect(seen?.principal.status).toBe("busy");

		const back = await alice.client.request("PATCH", "/api/me/status", {
			status: "available",
		});
		expect(back.status).toBe(200);
	});

	it("非法状态 → 400；未登录 → 401", async () => {
		await expectError(
			await alice.client.request("PATCH", "/api/me/status", {
				status: "offline",
			}),
			400,
			"BAD_REQUEST",
		);
		const anon = await anonymous.request("PATCH", "/api/me/status", {
			status: "busy",
		});
		expect(anon.status).toBe(401);
	});
});

describe("问分身（askTwin）", () => {
	it("两个真人的私聊里存进 message.posted 载荷；不传或 false 不带该字段", async () => {
		const conv = await dm(bob.client, alice.me.principal.id);
		const post = async (body: object) => {
			const res = await bob.client.request(
				"POST",
				`/api/conversations/${conv.id}/messages`,
				body,
			);
			expect(res.status).toBe(201);
			return PostMessageResponseSchema.parse(await res.json()).event.payload;
		};
		expect(await post({ text: "预算口径？", askTwin: true })).toEqual({
			text: "预算口径？",
			mentions: [],
			askTwin: true,
		});
		expect(await post({ text: "好的", askTwin: false })).toEqual({
			text: "好的",
			mentions: [],
		});
		expect(await post({ text: "谢谢" })).toEqual({
			text: "谢谢",
			mentions: [],
		});
	});

	it("自己与代理的私聊、群聊里传 askTwin:true → 400；非布尔 → 400", async () => {
		const own = await dm(alice.client, twinOf(alice).id);
		const groupRes = await alice.client.request("POST", "/api/conversations", {
			kind: "group",
			title: "问分身群",
			memberIds: [bob.me.principal.id, twinOf(bob).id],
		});
		const group = CreateConversationResponseSchema.parse(
			await groupRes.json(),
		).conversation;
		for (const id of [own.id, group.id]) {
			await expectError(
				await alice.client.request(
					"POST",
					`/api/conversations/${id}/messages`,
					{ text: "你好", askTwin: true },
				),
				400,
				"BAD_REQUEST",
			);
		}
		await expectError(
			await alice.client.request(
				"POST",
				`/api/conversations/${own.id}/messages`,
				{ text: "你好", askTwin: "yes" },
			),
			400,
			"BAD_REQUEST",
		);
	});
});

describe("协商卡片", () => {
	it("协商会话不进列表；两人私聊（原先没有则新建）落 negotiation.started；本人可读协商事件；确认待办指向私聊", async () => {
		const s = scoped(alice.me.tenant.id);
		expect(
			(await listOf(carol.client)).some((x) =>
				x.members.some((m) => m.id === alice.me.principal.id),
			),
		).toBe(false);

		const nego = await startNegotiation(s, {
			initiatorAgentId: twinOf(carol).id,
			responderAgentId: twinOf(alice).id,
			goal: "约周四讨论预算",
			title: "约周四讨论预算",
		});
		const proposal = { slot: "周四 15:00" };
		await appendNegotiationStep(s, nego.id, twinOf(carol).id, {
			status: "continue",
			message: "周四 15:00？",
			proposal,
		});
		await appendNegotiationStep(s, nego.id, twinOf(alice).id, {
			status: "agree",
			message: "可以",
			proposal,
		});
		await endNegotiation(s, nego.id, "agreed");

		for (const who of [carol, alice]) {
			const list = await listOf(who.client);
			expect(list.some((x) => x.conversation.id === nego.id)).toBe(false);
			expect(list.some((x) => x.conversation.kind === "negotiation")).toBe(
				false,
			);
		}

		const pair = (await listOf(carol.client)).filter(
			(x) =>
				x.conversation.kind === "dm" &&
				x.members.some((m) => m.id === alice.me.principal.id),
		);
		expect(pair).toHaveLength(1);
		const dmId = pair[0]?.conversation.id ?? "";
		expect(pair[0]?.members.map((m) => m.id).sort()).toEqual(
			[
				alice.me.principal.id,
				carol.me.principal.id,
				twinOf(alice).id,
				twinOf(carol).id,
			].sort(),
		);
		const started = (await eventsOf(alice.client, dmId)).filter(
			(e) => e.type === "negotiation.started",
		);
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({
			actorId: twinOf(carol).id,
			onBehalfOfId: carol.me.principal.id,
			payload: { negotiationConversationId: nego.id, goal: "约周四讨论预算" },
		});

		for (const who of [carol, alice]) {
			const steps = await eventsOf(who.client, nego.id);
			expect(steps.map((e) => e.type)).toEqual([
				"negotiation.step",
				"negotiation.step",
				"negotiation.ended",
			]);
			const items = WorkItemListResponseSchema.parse(
				await (await who.client.request("GET", "/api/work-items")).json(),
			).items.filter((w) => w.kind === "confirmation");
			expect(items).toHaveLength(1);
			expect(items[0]?.conversationId).toBe(dmId);
			expect(items[0]?.payload).toMatchObject({
				negotiationConversationId: nego.id,
				proposal,
			});
		}
		// 协商会话的事件对非当事人 404。
		expect(
			(await bob.client.request("GET", `/api/conversations/${nego.id}/events`))
				.status,
		).toBe(404);

		// 第二次协商复用同一个私聊。
		const again = await startNegotiation(s, {
			initiatorAgentId: twinOf(alice).id,
			responderAgentId: twinOf(carol).id,
			goal: "改到周五",
			title: "改到周五",
		});
		const dmEvents = await eventsOf(carol.client, dmId);
		expect(
			dmEvents.filter((e) => e.type === "negotiation.started").at(-1)?.payload,
		).toEqual({ negotiationConversationId: again.id, goal: "改到周五" });
	});
});
