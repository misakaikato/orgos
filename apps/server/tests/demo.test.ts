/**
 * 集成：演示数据（seed:demo 与 /api/dev/reset-demo 共用的 resetDemo）与模拟台接口。
 */
import {
	ConversationListResponseSchema,
	DemoPeopleResponseSchema,
	DevInfoResponseSchema,
	DevSessionResponseSchema,
	ErrorBodySchema,
	EventsResponseSchema,
	MeResponseSchema,
	ResetDemoResponseSchema,
	WorkItemListResponseSchema,
} from "@orgos/protocol";
import { count, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import {
	conversations,
	events,
	notes,
	principals,
	session,
	user,
	workItems,
} from "@/db/schema";
import { findUserIdByEmail } from "@/db/scope";
import { demoEmail } from "@/demo/people";
import { resetDemo } from "@/demo/seed";
import { app } from "@/index";
import { authenticateBrowserWs } from "@/realtime/browser-ws";
import {
	anonymous,
	type Client,
	createTeam,
	signUpAndIn,
	type TeamMember,
} from "./helpers";

async function countWhere(
	table:
		| typeof conversations
		| typeof events
		| typeof workItems
		| typeof notes
		| typeof principals,
	tenantId: string,
): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(table)
		.where(eq(table.tenantId, tenantId));
	return row?.n ?? 0;
}

async function tenantSnapshot(tenantId: string) {
	return {
		principals: await countWhere(principals, tenantId),
		conversations: await countWhere(conversations, tenantId),
		events: await countWhere(events, tenantId),
		workItems: await countWhere(workItems, tenantId),
		notes: await countWhere(notes, tenantId),
	};
}

async function expectError(res: Response, status: number, code: string) {
	expect(res.status).toBe(status);
	const body = ErrorBodySchema.parse(await res.json());
	expect(body.error.code).toBe(code);
}

function bearer(token: string, extra: Record<string, string> = {}) {
	return {
		"content-type": "application/json",
		authorization: `Bearer ${token}`,
		...extra,
	};
}

async function asToken(token: string, path: string, cookie?: string) {
	return app.request(path, {
		headers: bearer(token, cookie ? { cookie } : {}),
	});
}

let other: TeamMember;

afterEach(() => {
	vi.unstubAllEnvs();
});

beforeAll(async () => {
	[other] = (await createTeam(["Olga", "Oscar"])) as [TeamMember];
	const convRes = await other.client.request("POST", "/api/conversations", {
		kind: "dm",
		withPrincipalId: other.me.agents[0]?.principal.id,
	});
	expect(convRes.status).toBe(201);
});

describe("resetDemo（seed:demo）", () => {
	it("连续两次得到相同的数据量，其他租户不受影响", async () => {
		const before = await tenantSnapshot(other.me.tenant.id);
		const first = await resetDemo();
		const second = await resetDemo();
		expect(second).toEqual(first);
		expect(first).toMatchObject({ people: 4, openWorkItems: 3 });
		expect(first.conversations).toBeGreaterThanOrEqual(5);
		expect(await tenantSnapshot(other.me.tenant.id)).toEqual(before);

		// 旧用户已删除（只剩一个同邮箱用户），session 随之清空。
		const users = await db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, demoEmail("linxiao")));
		expect(users).toHaveLength(1);
		const userId = users[0]?.id ?? "";
		const [sessions] = await db
			.select({ n: count() })
			.from(session)
			.where(eq(session.userId, userId));
		expect(sessions?.n).toBe(0);
	});

	it("预置内容：林晓有一条 open 的 decision，陈安与周野各有一条 open 的 confirmation", async () => {
		vi.stubEnv("ORGOS_DEV", "1");
		const tokenOf = async (handle: string) => {
			const res = await app.request("/api/dev/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ handle }),
			});
			expect(res.status).toBe(201);
			return DevSessionResponseSchema.parse(await res.json()).token;
		};
		const openItems = async (handle: string) => {
			const res = await asToken(
				await tokenOf(handle),
				"/api/work-items?status=open",
			);
			expect(res.status).toBe(200);
			return WorkItemListResponseSchema.parse(await res.json()).items;
		};
		const lin = await openItems("linxiao");
		expect(lin.map((w) => w.kind)).toEqual(["decision"]);
		expect(lin[0]?.payload).toMatchObject({ question: expect.any(String) });
		expect((await openItems("chenan")).map((w) => w.kind)).toEqual([
			"confirmation",
		]);
		expect((await openItems("zhouye")).map((w) => w.kind)).toEqual([
			"confirmation",
		]);
		expect(await openItems("xunuo")).toEqual([]);

		// 林晓以 observer 身份看得到许诺找她幕僚长的会话，里面有"已转给本人"。
		const token = await tokenOf("linxiao");
		const list = ConversationListResponseSchema.parse(
			await (await asToken(token, "/api/conversations")).json(),
		).items;
		const c3 = list.find((x) => x.conversation.id === lin[0]?.conversationId);
		expect(c3?.members.map((m) => m.handle).sort()).toEqual(
			["linxiao", "linxiao-chief", "xunuo"].sort(),
		);
		const evs = EventsResponseSchema.parse(
			await (
				await asToken(token, `/api/conversations/${c3?.conversation.id}/events`)
			).json(),
		).items;
		expect(evs.map((e) => e.type)).toContain("escalation.created");
		const members = c3?.members ?? [];
		const idOf = (h: string) => members.find((m) => m.handle === h)?.id;
		const agentMsg = evs.find(
			(e) => e.type === "message.posted" && e.onBehalfOfId !== null,
		);
		expect(agentMsg?.actorId).toBe(idOf("linxiao-chief"));
		expect(agentMsg?.onBehalfOfId).toBe(idOf("linxiao"));

		// 陈安（observer）看得到已结束、结果为 agreed 的协商。
		const chenan = await tokenOf("chenan");
		const nego = ConversationListResponseSchema.parse(
			await (await asToken(chenan, "/api/conversations")).json(),
		).items.find((x) => x.conversation.kind === "negotiation");
		const negoEvents = EventsResponseSchema.parse(
			await (
				await asToken(
					chenan,
					`/api/conversations/${nego?.conversation.id}/events`,
				)
			).json(),
		).items;
		expect(negoEvents.at(-1)).toMatchObject({
			type: "negotiation.ended",
			payload: { outcome: "agreed" },
		});
	});
});

describe("/api/dev/* 与 /sim", () => {
	it("ORGOS_DEV 未设置时一律 404", async () => {
		vi.stubEnv("ORGOS_DEV", "");
		await expectError(
			await anonymous.request("GET", "/api/dev/info"),
			404,
			"NOT_FOUND",
		);
		await expectError(
			await anonymous.request("GET", "/api/dev/people"),
			404,
			"NOT_FOUND",
		);
		await expectError(
			await anonymous.request("POST", "/api/dev/sessions", {
				handle: "linxiao",
			}),
			404,
			"NOT_FOUND",
		);
		await expectError(
			await anonymous.request("POST", "/api/dev/reset-demo", {}),
			404,
			"NOT_FOUND",
		);
		await expectError(await anonymous.request("GET", "/sim"), 404, "NOT_FOUND");
	});

	it("info：有 key 且未设 MOCK_LLM 为 real，否则 mock", async () => {
		vi.stubEnv("ORGOS_DEV", "1");
		const info = async () =>
			DevInfoResponseSchema.parse(
				await (await anonymous.request("GET", "/api/dev/info")).json(),
			);
		vi.stubEnv("DEEPSEEK_API_KEY", "");
		vi.stubEnv("MOCK_LLM", "");
		expect(await info()).toEqual({ modelMode: "mock", model: "mock" });
		vi.stubEnv("DEEPSEEK_API_KEY", "sk-placeholder");
		expect(await info()).toEqual({
			modelMode: "real",
			model: "deepseek-v4-flash",
		});
		vi.stubEnv("MOCK_LLM", "1");
		expect((await info()).modelMode).toBe("mock");
	});

	it("people：只列星河科技四人", async () => {
		vi.stubEnv("ORGOS_DEV", "1");
		const res = await anonymous.request("GET", "/api/dev/people");
		const { people } = DemoPeopleResponseSchema.parse(await res.json());
		expect(people.map((p) => p.handle)).toEqual([
			"linxiao",
			"zhouye",
			"chenan",
			"xunuo",
		]);
	});

	it("sessions：演示人物得到可作 Bearer 的 token；非演示人物 404；参数错 400", async () => {
		vi.stubEnv("ORGOS_DEV", "1");
		const res = await anonymous.request("POST", "/api/dev/sessions", {
			handle: "linxiao",
		});
		expect(res.status).toBe(201);
		const { token, principal } = DevSessionResponseSchema.parse(
			await res.json(),
		);
		expect(principal.displayName).toBe("林晓");
		const me = MeResponseSchema.parse(
			await (await asToken(token, "/api/me")).json(),
		);
		expect(me.principal.handle).toBe("linxiao");
		expect(me.tenant.name).toBe("星河科技");

		const alice = other.me.principal.handle;
		await expectError(
			await anonymous.request("POST", "/api/dev/sessions", { handle: alice }),
			404,
			"NOT_FOUND",
		);
		await expectError(
			await anonymous.request("POST", "/api/dev/sessions", { handle: "X" }),
			400,
			"BAD_REQUEST",
		);
	});

	it("多身份不串：同一浏览器的 cookie 属于别人时，各 token 仍是各自的人（REST 与 WS）", async () => {
		vi.stubEnv("ORGOS_DEV", "1");
		const cookieOwner: Client = await signUpAndIn("Cookie");
		const cookie = cookieOwner.headers.cookie ?? "";
		const tokens: Record<string, string> = {};
		for (const handle of ["linxiao", "zhouye", "xunuo"]) {
			const res = await anonymous.request("POST", "/api/dev/sessions", {
				handle,
			});
			tokens[handle] = DevSessionResponseSchema.parse(await res.json()).token;
		}
		for (const [handle, token] of Object.entries(tokens)) {
			const me = MeResponseSchema.parse(
				await (await asToken(token, "/api/me", cookie)).json(),
			);
			expect(me.principal.handle).toBe(handle);
			const ws = await authenticateBrowserWs(
				new Request(`http://localhost:8930/ws?token=${token}`, {
					headers: { cookie },
				}),
			);
			expect(ws.ok).toBe(true);
			if (ws.ok) expect(ws.principalId).toBe(me.principal.id);
		}
	});

	it("reset-demo：与 seed:demo 同一实现，重建后旧 token 失效", async () => {
		vi.stubEnv("ORGOS_DEV", "1");
		const old = DevSessionResponseSchema.parse(
			await (
				await anonymous.request("POST", "/api/dev/sessions", {
					handle: "zhouye",
				})
			).json(),
		);
		const oldUserId = await findUserIdByEmail(demoEmail("zhouye"));
		const res = await anonymous.request("POST", "/api/dev/reset-demo", {});
		expect(res.status).toBe(200);
		const { counts } = ResetDemoResponseSchema.parse(await res.json());
		expect(counts).toMatchObject({ people: 4, openWorkItems: 3 });
		expect(await findUserIdByEmail(demoEmail("zhouye"))).not.toBe(oldUserId);
		expect((await asToken(old.token, "/api/me")).status).toBe(401);
	});
});
