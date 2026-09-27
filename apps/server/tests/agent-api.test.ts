/**
 * 集成：代理组、资料、用量接口的权限与形态。
 */
import {
	AgentListResponseSchema,
	AgentResponseSchema,
	NoteListResponseSchema,
	NoteResponseSchema,
	UsageResponseSchema,
} from "@orgos/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { openDm, say } from "./agent-helpers";
import { createTeam, type TeamMember, uniq } from "./helpers";

let alice: TeamMember;
let bob: TeamMember;
let dave: TeamMember;
let twin: string;

beforeAll(async () => {
	[alice, bob] = (await createTeam(["Alice", "Bob"])) as [
		TeamMember,
		TeamMember,
	];
	[dave] = (await createTeam(["Dave"])) as [TeamMember];
	twin = alice.me.agents[0]?.principal.id ?? "";
});

async function createAssistant(member: TeamMember, handle = uniq("helper-")) {
	const res = await member.client.request("POST", "/api/agents", {
		displayName: "写作助手",
		handle,
		description: "帮我润色文案",
	});
	return res;
}

describe("/api/agents", () => {
	it("列出我的代理组：分身在前", async () => {
		const res = await alice.client.request("GET", "/api/agents");
		expect(res.status).toBe(200);
		const { items } = AgentListResponseSchema.parse(await res.json());
		expect(items.map((a) => a.role)).toEqual(["front", "specialist"]);
	});

	it("新建助手 201；handle 冲突 409；不合法 400", async () => {
		const handle = uniq("writer-");
		const res = await createAssistant(alice, handle);
		expect(res.status).toBe(201);
		const { agent } = AgentResponseSchema.parse(await res.json());
		expect(agent).toMatchObject({
			role: "specialist",
			description: "帮我润色文案",
			principal: { handle, ownerId: alice.me.principal.id, kind: "agent" },
		});
		expect((await createAssistant(bob, handle)).status).toBe(409);
		expect((await createAssistant(alice, "Bad Handle")).status).toBe(400);
	});

	it("PATCH：改描述与分身的对外政策；助手没有对外政策 400", async () => {
		let res = await alice.client.request("PATCH", `/api/agents/${twin}`, {
			description: "对外代表我",
			delegationPolicy: "排期问我",
		});
		expect(res.status).toBe(200);
		expect(AgentResponseSchema.parse(await res.json()).agent).toMatchObject({
			description: "对外代表我",
			delegationPolicy: "排期问我",
		});
		const ops = alice.me.agents[1]?.principal.id;
		res = await alice.client.request("PATCH", `/api/agents/${ops}`, {
			delegationPolicy: "随便",
		});
		expect(res.status).toBe(400);
	});

	it("别人的代理 403，跨租户与不存在 404", async () => {
		expect(
			(
				await bob.client.request("PATCH", `/api/agents/${twin}`, {
					description: "x",
				})
			).status,
		).toBe(403);
		expect(
			(await bob.client.request("DELETE", `/api/agents/${twin}`)).status,
		).toBe(403);
		expect(
			(await dave.client.request("DELETE", `/api/agents/${twin}`)).status,
		).toBe(404);
		expect(
			(await alice.client.request("DELETE", "/api/agents/not-a-uuid")).status,
		).toBe(404);
	});

	it("分身不能删 403；删助手 204 后不再出现、不再回应，历史消息保留", async () => {
		expect(
			(await alice.client.request("DELETE", `/api/agents/${twin}`)).status,
		).toBe(403);
		const created = AgentResponseSchema.parse(
			await (await createAssistant(alice)).json(),
		).agent;
		const cid = await openDm(alice.client, created.principal.id);
		await say(alice.client, cid, "你好");
		const del = await alice.client.request(
			"DELETE",
			`/api/agents/${created.principal.id}`,
		);
		expect(del.status).toBe(204);
		const { items } = AgentListResponseSchema.parse(
			await (await alice.client.request("GET", "/api/agents")).json(),
		);
		expect(items.some((a) => a.principal.id === created.principal.id)).toBe(
			false,
		);
		await say(alice.client, cid, "还在吗");
		const events = (await (
			await alice.client.request("GET", `/api/conversations/${cid}/events`)
		).json()) as { items: { actorId: string; type: string }[] };
		const replies = events.items.filter(
			(e) => e.type === "message.posted" && e.actorId === created.principal.id,
		);
		expect(replies).toHaveLength(1);
		expect(
			(
				await alice.client.request("POST", "/api/conversations", {
					kind: "dm",
					withPrincipalId: created.principal.id,
				})
			).status,
		).toBe(404);
	});
});

describe("/api/notes", () => {
	it("增改删只作用于自己的资料；别人的一律 404", async () => {
		let res = await alice.client.request("POST", "/api/notes", {
			title: "路线图",
			body: "10 月 31 日上线",
		});
		expect(res.status).toBe(201);
		const { note } = NoteResponseSchema.parse(await res.json());
		expect(note).toMatchObject({
			ownerId: alice.me.principal.id,
			authorId: alice.me.principal.id,
			visibility: "private",
		});

		res = await alice.client.request("PATCH", `/api/notes/${note.id}`, {
			visibility: "shared",
		});
		expect(res.status).toBe(200);
		expect(NoteResponseSchema.parse(await res.json()).note.visibility).toBe(
			"shared",
		);

		expect(
			(
				await bob.client.request("PATCH", `/api/notes/${note.id}`, {
					title: "改掉",
				})
			).status,
		).toBe(404);
		expect(
			(await dave.client.request("DELETE", `/api/notes/${note.id}`)).status,
		).toBe(404);
		const bobList = NoteListResponseSchema.parse(
			await (await bob.client.request("GET", "/api/notes")).json(),
		);
		expect(bobList.items.some((n) => n.id === note.id)).toBe(false);

		expect(
			(await alice.client.request("DELETE", `/api/notes/${note.id}`)).status,
		).toBe(204);
		expect(
			(await alice.client.request("DELETE", `/api/notes/${note.id}`)).status,
		).toBe(404);
	});

	it("标题为空 400", async () => {
		const res = await alice.client.request("POST", "/api/notes", {
			title: " ",
			body: "x",
		});
		expect(res.status).toBe(400);
	});
});

describe("/api/usage", () => {
	it("按代理汇总请求数与 tokens；只含自己的代理", async () => {
		const cid = await openDm(alice.client, twin);
		await say(alice.client, cid, "统计一下");
		const res = await alice.client.request("GET", "/api/usage");
		expect(res.status).toBe(200);
		const { byAgent } = UsageResponseSchema.parse(await res.json());
		const mine = byAgent.find((u) => u.agentId === twin);
		expect(mine?.requests).toBeGreaterThanOrEqual(1);
		expect(mine?.outputTokens).toBeGreaterThan(0);
		const bobs = UsageResponseSchema.parse(
			await (await bob.client.request("GET", "/api/usage")).json(),
		);
		expect(bobs.byAgent.some((u) => u.agentId === twin)).toBe(false);
	});
});
