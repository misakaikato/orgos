/**
 * 集成（MOCK_LLM=1）：应用接口工具——目录完整性、本人经分身操作软件（事件记为代理代办）、
 * excluded 接口一律拒绝、替他人办事时的收窄（private_read 拒绝、三个低风险动作的参数约束）、
 * 伪造内部上下文无效、协商会话与单元分身里不可用。
 */
import {
	ConversationListResponseSchema,
	type Event,
	MeResponseSchema,
} from "@orgos/protocol";
import { eq } from "drizzle-orm";
import { inspectRoutes } from "hono/dev";
import { beforeAll, describe, expect, it } from "vitest";
import { API_CATALOG, entryKey, searchEntries } from "@/agent/app-api/catalog";
import { buildSystemPrompt } from "@/agent/prompt";
import { RunSession } from "@/agent/session";
import { availableTools } from "@/agent/tools";
import type { ToolScope } from "@/agent/tools/tool";
import { principals, taskLogs } from "@/db/schema";
import { scoped } from "@/db/scope";
import { app, createApp } from "@/index";
import { findAgent } from "@/services/agents";
import { actions, eventsOf, messagesBy, openDm, say } from "./agent-helpers";
import {
	type Client,
	createTeam,
	signUpAndIn,
	type TeamMember,
	uniq,
} from "./helpers";

let alice: TeamMember;
let bob: TeamMember;
let carol: TeamMember;
let aliceTwin: string;
let bobTwin: string;
let ownDm: string;
let pairDm: string;
let aliceCarolDm: string;

beforeAll(async () => {
	[alice, bob, carol] = (await createTeam(["Alice", "Bob", "Carol"])) as [
		TeamMember,
		TeamMember,
		TeamMember,
	];
	const twinOf = (m: TeamMember) =>
		m.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
	aliceTwin = twinOf(alice);
	bobTwin = twinOf(bob);
	ownDm = await openDm(alice.client, aliceTwin);
	pairDm = await openDm(bob.client, alice.me.principal.id);
	aliceCarolDm = await openDm(alice.client, carol.me.principal.id);
});

const tenant = () => scoped(alice.me.tenant.id);

async function conversationTitled(c: Client, title: string) {
	const res = await c.request("GET", "/api/conversations");
	expect(res.status).toBe(200);
	return ConversationListResponseSchema.parse(await res.json()).items.find(
		(i) => i.conversation.title === title,
	);
}

/** 本次指令引起的最后一条代理动作与分身的最后一条回复。 */
async function lastOutcome(conversationId: string, agentId: string) {
	const events = await eventsOf(alice.client, conversationId);
	const acts = actions(events).filter((a) => a.actorId === agentId);
	const replies = messagesBy(events, agentId);
	return { action: acts.at(-1), reply: replies.at(-1)?.payload.text ?? "" };
}

describe("接口目录", () => {
	it("与 Hono 实际注册的路由一一对应", () => {
		const registered = new Set(
			inspectRoutes(createApp())
				.filter((r) => !r.isMiddleware)
				.map((r) => `${r.method} ${r.path}`),
		);
		const catalogued = API_CATALOG.map(entryKey);
		expect(new Set(catalogued).size).toBe(catalogued.length);
		expect([...registered].filter((k) => !catalogued.includes(k))).toEqual([]);
		expect(catalogued.filter((k) => !registered.has(k))).toEqual([]);
	});

	it("规格点名的接口是 excluded", () => {
		const excluded = new Set(
			API_CATALOG.filter((e) => e.risk === "excluded").map(entryKey),
		);
		for (const key of [
			"GET /api/auth/*",
			"POST /api/auth/*",
			"POST /api/onboarding",
			"POST /api/runners/pair",
			"POST /api/runners/pairing-codes",
			"GET /ws",
			"GET /runner/ws",
			"ALL /llm/*",
			"POST /api/dev/sessions",
		])
			expect(excluded.has(key)).toBe(true);
	});

	it("按关键词检索：建群找到建会话接口", () => {
		const found = searchEntries(API_CATALOG, "建群");
		expect(found[0] && entryKey(found[0])).toBe("POST /api/conversations");
	});
});

describe("为本人：经分身操作软件", () => {
	it("拉群：群建成，成员含三人及各自分身；建群事件记为分身代本人", async () => {
		const body = {
			kind: "group",
			title: "结算页联调",
			memberIds: [bob.me.principal.id, carol.me.principal.id],
		};
		await say(
			alice.client,
			ownDm,
			`#api POST /api/conversations ${JSON.stringify(body)}`,
		);
		const { action, reply } = await lastOutcome(ownDm, aliceTwin);
		expect(action?.payload).toMatchObject({ tool: "app_api_call", ok: true });
		expect(action?.payload.summary).toContain("POST /api/conversations");
		expect(reply).toMatch(/^完成：HTTP 201/);

		const group = await conversationTitled(bob.client, "结算页联调");
		expect(group).toBeDefined();
		const memberIds = new Set(group?.members.map((m) => m.id));
		for (const m of [alice, bob, carol]) {
			expect(memberIds.has(m.me.principal.id)).toBe(true);
			const twin = m.me.agents.find((a) => a.role === "front");
			expect(memberIds.has(twin?.principal.id ?? "")).toBe(true);
		}
		const joined = (
			await eventsOf(bob.client, group?.conversation.id ?? "")
		).filter((e) => e.type === "member.joined");
		expect(joined.length).toBeGreaterThan(0);
		for (const e of joined) {
			expect(e.actorId).toBe(aliceTwin);
			expect(e.onBehalfOfId).toBe(alice.me.principal.id);
		}

		const logs = await tenant().select(taskLogs);
		const titles = logs.map(
			(l) => `${l.kind}:${(l.payload as { title?: string }).title}`,
		);
		expect(titles).toContain("tool_call:POST /api/conversations");
		expect(titles).toContain("tool_result:POST /api/conversations");
	});

	it("代发的消息记在分身名下，不触发任何代理", async () => {
		await say(
			alice.client,
			ownDm,
			`#api POST /api/conversations/${pairDm}/messages {"text":"周五前给你"}`,
		);
		const events = await eventsOf(bob.client, pairDm);
		const [posted] = messagesBy(events, aliceTwin);
		expect(posted?.payload.text).toBe("周五前给你");
		expect(posted?.onBehalfOfId).toBe(alice.me.principal.id);
		expect(messagesBy(events, alice.me.principal.id)).toHaveLength(0);
		expect(messagesBy(events, bobTwin)).toHaveLength(0);
	});

	it("代发的消息可以是 html；分身自己的回复记为 md", async () => {
		const body = { text: "<p>排期见<b>下表</b></p>", format: "html" };
		await say(
			alice.client,
			ownDm,
			`#api POST /api/conversations/${pairDm}/messages ${JSON.stringify(body)}`,
		);
		const { action } = await lastOutcome(ownDm, aliceTwin);
		expect(action?.payload).toMatchObject({ tool: "app_api_call", ok: true });
		const posted = messagesBy(await eventsOf(bob.client, pairDm), aliceTwin).at(
			-1,
		);
		expect(posted?.payload).toMatchObject(body);
		expect(posted?.onBehalfOfId).toBe(alice.me.principal.id);
		const reply = messagesBy(await eventsOf(alice.client, ownDm), aliceTwin).at(
			-1,
		);
		expect(reply?.payload.format).toBe("md");
	});

	it("excluded 接口经工具调用一律拒绝，不执行", async () => {
		for (const target of [
			"GET /api/dev/info",
			"POST /api/runners/pairing-codes {}",
			"GET /api/auth/get-session",
			"GET /api/conversations/../dev/info",
			"GET /api/%64ev/info",
			"GET /api/no-such-thing",
		]) {
			await say(alice.client, ownDm, `#api ${target}`);
			const { action } = await lastOutcome(ownDm, aliceTwin);
			expect(action?.payload.ok, target).toBe(false);
			expect(action?.payload.tool).toBe("app_api_call");
		}
		const res = await alice.client.request("GET", "/api/runners");
		expect(res.status).toBe(200);
		expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(0);
	});

	it("本人私有数据可读（private_read 为本人开放）", async () => {
		await say(alice.client, ownDm, "#api GET /api/work-items?status=open");
		const { action, reply } = await lastOutcome(ownDm, aliceTwin);
		expect(action?.payload.ok).toBe(true);
		expect(reply).toMatch(/^完成：HTTP 200/);
	});
});

describe("为他人：只开放 public_read 与三个低风险动作", () => {
	const ask = (text: string) =>
		say(bob.client, pairDm, text, { askTwin: true });

	it("private_read 一律拒绝", async () => {
		for (const path of [
			"/api/work-items",
			`/api/conversations/${aliceCarolDm}/events`,
			"/api/notes",
		]) {
			await ask(`#api GET ${path}`);
			const { action, reply } = await lastOutcome(pairDm, aliceTwin);
			expect(action?.payload.ok, path).toBe(false);
			expect(reply).toContain("无权限");
			expect(reply).toContain("escalate_to_owner");
		}
	});

	it("public_read 可以", async () => {
		await ask("#api GET /api/directory");
		const { action } = await lastOutcome(pairDm, aliceTwin);
		expect(action?.payload.ok).toBe(true);
	});

	it("替本人发消息被拒", async () => {
		await ask(
			`#api POST /api/conversations/${aliceCarolDm}/messages {"text":"替林晓说"}`,
		);
		const { action } = await lastOutcome(pairDm, aliceTwin);
		expect(action?.payload.ok).toBe(false);
		expect(
			messagesBy(await eventsOf(alice.client, aliceCarolDm), aliceTwin),
		).toHaveLength(0);
	});

	it("建群：不含提问人被拒、开私聊被拒，含提问人的群建成", async () => {
		await ask(
			`#api POST /api/conversations ${JSON.stringify({ kind: "group", title: "无提问人", memberIds: [carol.me.principal.id] })}`,
		);
		expect((await lastOutcome(pairDm, aliceTwin)).action?.payload.ok).toBe(
			false,
		);
		expect(await conversationTitled(alice.client, "无提问人")).toBeUndefined();

		await ask(
			`#api POST /api/conversations ${JSON.stringify({ kind: "dm", withPrincipalId: carol.me.principal.id })}`,
		);
		expect((await lastOutcome(pairDm, aliceTwin)).action?.payload.ok).toBe(
			false,
		);

		await ask(
			`#api POST /api/conversations ${JSON.stringify({ kind: "group", title: "拉上周野", memberIds: [bob.me.principal.id, carol.me.principal.id] })}`,
		);
		expect((await lastOutcome(pairDm, aliceTwin)).action?.payload.ok).toBe(
			true,
		);
		const group = await conversationTitled(bob.client, "拉上周野");
		expect(group?.members.map((m) => m.id)).toContain(bob.me.principal.id);
	});

	it("开话题与加人：会话里没有提问人被拒，有则可以", async () => {
		await ask(
			`#api POST /api/conversations/${aliceCarolDm}/topics {"title":"偷开"}`,
		);
		expect((await lastOutcome(pairDm, aliceTwin)).action?.payload.ok).toBe(
			false,
		);
		await ask(`#api POST /api/conversations/${pairDm}/topics {"title":"排期"}`);
		expect((await lastOutcome(pairDm, aliceTwin)).action?.payload.ok).toBe(
			true,
		);

		const settled = await conversationTitled(alice.client, "结算页联调");
		const group = settled?.conversation.id ?? "";
		const outsider = await createOutsiderGroup();
		const dave = await joinTenant("Dave");
		await ask(
			`#api POST /api/conversations/${outsider}/members {"principalId":"${dave}"}`,
		);
		expect((await lastOutcome(pairDm, aliceTwin)).action?.payload.ok).toBe(
			false,
		);
		await ask(
			`#api POST /api/conversations/${pairDm}/members {"principalId":"${dave}"}`,
		);
		expect((await lastOutcome(pairDm, aliceTwin)).action?.payload.ok).toBe(
			false,
		);
		await ask(
			`#api POST /api/conversations/${group}/members {"principalId":"${dave}"}`,
		);
		expect((await lastOutcome(pairDm, aliceTwin)).action?.payload.ok).toBe(
			true,
		);
		const joined = (await eventsOf(bob.client, group)).find(
			(e): e is Extract<Event, { type: "member.joined" }> =>
				e.type === "member.joined" && e.payload.principalId === dave,
		);
		expect(joined?.actorId).toBe(aliceTwin);
		expect(joined?.onBehalfOfId).toBe(alice.me.principal.id);
	});
});

/** alice 与 carol 的群（bob 不在）。 */
async function createOutsiderGroup(): Promise<string> {
	const res = await alice.client.request("POST", "/api/conversations", {
		kind: "group",
		title: "没有 bob 的群",
		memberIds: [carol.me.principal.id],
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { conversation: { id: string } }).conversation
		.id;
}

/** 以邀请码加入 alice 的租户的新成员，返回其本人主体 id。 */
async function joinTenant(name: string): Promise<string> {
	const c = await signUpAndIn(name);
	const res = await c.request("POST", "/api/onboarding", {
		mode: "join",
		inviteCode: alice.me.tenant.inviteCode,
		displayName: name,
		handle: uniq(name.toLowerCase()),
	});
	expect(res.status).toBe(201);
	return MeResponseSchema.parse(
		await (await c.request("GET", "/api/me")).json(),
	).principal.id;
}

describe("伪造内部上下文", () => {
	it("网络请求带不进内部上下文：env 里的同名键、同描述的 Symbol、请求头都无效", async () => {
		const pretend = {
			user: { id: "x", email: "x@orgos.test", name: "x" },
			delegation: { agentId: aliceTwin, ownerId: alice.me.principal.id },
		};
		const envs: unknown[] = [
			{ internalCaller: pretend },
			{ [Symbol("orgos.internal-caller")]: pretend },
			{ [Symbol.for("orgos.internal-caller")]: pretend },
		];
		for (const env of envs) {
			const res = await app.request("/api/me", {}, env as never);
			expect(res.status).toBe(401);
		}
		const res = await app.request("/api/me", {
			headers: {
				"x-orgos-internal-caller": JSON.stringify(pretend),
				"x-orgos-agent": aliceTwin,
			},
		});
		expect(res.status).toBe(401);
	});
});

describe("可用性", () => {
	async function scopeFor(
		kind: "dm" | "negotiation",
		actingFor: ToolScope["actingFor"],
	): Promise<ToolScope> {
		const agent = await findAgent(tenant(), { id: aliceTwin });
		const owner = await tenant().first(
			principals,
			eq(principals.id, alice.me.principal.id),
		);
		if (!agent || !owner) throw new Error("缺少分身");
		return {
			s: tenant(),
			agent,
			owner,
			unit: null,
			conversation: { id: "c", kind, topicId: "t" },
			runId: "r",
			actingFor,
			depth: 0,
			triggerEventId: null,
			session: new RunSession(),
			teammates: [],
			delegate: () => Promise.resolve({ outcome: "returned" as const }),
			startNegotiation: () => {},
		};
	}

	it("系统提示：为本人先查接口再调用；为他人其余操作转给本人", async () => {
		const prompt = async (actingFor: ToolScope["actingFor"]) => {
			const scope = await scopeFor("dm", actingFor);
			return buildSystemPrompt({
				scope,
				tools: availableTools(scope),
				requesterName: actingFor.kind === "other" ? "Bob" : null,
				conversationTitle: null,
				topicTitle: null,
				delegatedBy: null,
				resume: null,
			});
		};
		const own = await prompt({ kind: "owner" });
		expect(own).toContain("先用 app_api_search 找接口，再用 app_api_call 调用");
		expect(own).toContain("不许编造接口或参数");
		const other = await prompt({
			kind: "other",
			principalId: bob.me.principal.id,
		});
		expect(other).toContain("建一个包含Bob的群");
		expect(other).toContain("立即调用 escalate_to_owner");
	});

	it("私聊里为本人、为他人都有两个工具；协商会话里没有", async () => {
		const names = async (s: ToolScope) => availableTools(s).map((t) => t.name);
		for (const actingFor of [
			{ kind: "owner" as const },
			{ kind: "other" as const, principalId: bob.me.principal.id },
		]) {
			expect(await names(await scopeFor("dm", actingFor))).toEqual(
				expect.arrayContaining(["app_api_search", "app_api_call"]),
			);
			const inNegotiation = await names(
				await scopeFor("negotiation", actingFor),
			);
			expect(inNegotiation).not.toContain("app_api_search");
			expect(inNegotiation).not.toContain("app_api_call");
		}
	});
});
