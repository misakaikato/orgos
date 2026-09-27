/**
 * 集成：真实 Postgres（orgos_test）+ 进程内 Hono app。
 */
import {
	DirectoryResponseSchema,
	ErrorBodySchema,
	MeResponseSchema,
	OnboardingResponseSchema,
} from "@orgos/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "@/index";
import {
	anonymous,
	bearerClient,
	type Client,
	signUpAndIn,
	uniq,
} from "./helpers";

async function onboardCreate(c: Client, handle: string, displayName: string) {
	const res = await c.request("POST", "/api/onboarding", {
		mode: "create",
		orgName: uniq("org-"),
		displayName,
		handle,
	});
	expect(res.status).toBe(201);
	return OnboardingResponseSchema.parse(await res.json());
}

async function onboardJoin(
	c: Client,
	inviteCode: string,
	handle: string,
	displayName: string,
) {
	const res = await c.request("POST", "/api/onboarding", {
		mode: "join",
		inviteCode,
		displayName,
		handle,
	});
	expect(res.status).toBe(201);
	return OnboardingResponseSchema.parse(await res.json());
}

async function expectError(res: Response, status: number, code: string) {
	expect(res.status).toBe(status);
	const body = ErrorBodySchema.parse(await res.json());
	expect(body.error.code).toBe(code);
}

describe("GET /healthz", () => {
	it("200 ok", async () => {
		const res = await anonymous.request("GET", "/healthz");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});
});

describe("未登录", () => {
	it.each([
		["POST", "/api/onboarding"],
		["GET", "/api/me"],
		["GET", "/api/directory"],
	])("%s %s → 401", async (method, path) => {
		await expectError(
			await anonymous.request(method, path, method === "POST" ? {} : undefined),
			401,
			"UNAUTHORIZED",
		);
	});

	it("未知 /api 路由 → 404 统一错误体", async () => {
		await expectError(
			await anonymous.request("GET", "/api/nope"),
			404,
			"NOT_FOUND",
		);
	});
});

describe("onboarding 成功", () => {
	let owner: Client;
	let joiner: Client;
	let inviteCode: string;
	const handle = uniq("a");

	beforeAll(async () => {
		owner = await signUpAndIn("Alice");
		joiner = await signUpAndIn("Bob");
	});

	it("create：建租户、本人主体与两个代理，owner 看得到邀请码", async () => {
		const body = await onboardCreate(owner, handle, "Alice");
		expect(body.tenant.inviteCode).toMatch(/^[A-Z0-9]{10}$/);
		inviteCode = body.tenant.inviteCode as string;
		expect(body.principal).toMatchObject({
			kind: "human",
			handle,
			displayName: "Alice",
			ownerId: null,
		});
		const [twin, ops] = body.agents;
		expect(twin?.role).toBe("front");
		expect(twin?.principal).toMatchObject({
			kind: "agent",
			handle: `${handle}-twin`,
			displayName: "Alice的分身",
			ownerId: body.principal.id,
			userId: null,
		});
		expect(ops?.role).toBe("specialist");
		expect(ops?.principal.handle).toBe(`${handle}-ops`);
		expect(ops?.principal.displayName).toBe("Alice的执行助手");
		expect(twin?.model).toBe("deepseek-v4-flash");
		expect(twin?.description.length).toBeGreaterThan(0);
		expect(body.principal.status).toBe("available");
		expect(twin?.principal.status).toBeUndefined();
	});

	it("GET /api/me 返回本人、租户与代理组", async () => {
		const res = await owner.request("GET", "/api/me");
		expect(res.status).toBe(200);
		const me = MeResponseSchema.parse(await res.json());
		expect(me.user.email).toBe(owner.email);
		expect(me.tenant.inviteCode).toBe(inviteCode);
		expect(me.principal.handle).toBe(handle);
		expect(me.agents.map((a) => a.role)).toEqual(["front", "specialist"]);
	});

	it("join：邀请码大小写不敏感；成员看不到邀请码", async () => {
		const body = await onboardJoin(
			joiner,
			` ${inviteCode.toLowerCase()} `,
			uniq("b"),
			"Bob",
		);
		expect(body.tenant.inviteCode).toBeUndefined();
		const me = MeResponseSchema.parse(
			await (await joiner.request("GET", "/api/me")).json(),
		);
		expect(me.tenant.inviteCode).toBeUndefined();
		expect(me.tenant.id).toBe(body.tenant.id);
	});

	it("GET /api/directory 列出本租户所有人及其分身", async () => {
		const res = await joiner.request("GET", "/api/directory");
		expect(res.status).toBe(200);
		const { people } = DirectoryResponseSchema.parse(await res.json());
		expect(people).toHaveLength(2);
		for (const p of people) {
			expect(p.principal.kind).toBe("human");
			expect(p.front.ownerId).toBe(p.principal.id);
			expect(p.front.handle).toBe(`${p.principal.handle}-twin`);
		}
	});

	it("cookie 与 bearer 同时出现时以 bearer 为准", async () => {
		const b = await bearerClient(joiner.email);
		const res = await b.request("GET", "/api/me");
		const both = await app.request("/api/me", {
			headers: {
				...owner.headers,
				authorization: (b.headers as { authorization: string }).authorization,
			},
		});
		expect(res.status).toBe(200);
		const me = MeResponseSchema.parse(await both.json());
		expect(me.user.email).toBe(joiner.email);
	});

	it("bearer token 与 cookie 等价", async () => {
		const b = await bearerClient(owner.email);
		const me = MeResponseSchema.parse(
			await (await b.request("GET", "/api/me")).json(),
		);
		expect(me.principal.handle).toBe(handle);
	});
});

describe("onboarding 409", () => {
	it("已有成员身份再次 onboarding → 409 ALREADY_ONBOARDED", async () => {
		const c = await signUpAndIn();
		await onboardCreate(c, uniq("x"), "X");
		const again = await c.request("POST", "/api/onboarding", {
			mode: "create",
			orgName: "另一家",
			displayName: "X",
			handle: uniq("x"),
		});
		await expectError(again, 409, "ALREADY_ONBOARDED");
	});

	it("租户内 handle 冲突 → 409 HANDLE_TAKEN，且不留下半截数据", async () => {
		const owner = await signUpAndIn();
		const handle = uniq("h");
		const created = await onboardCreate(owner, handle, "H");
		const other = await signUpAndIn();
		const dup = await other.request("POST", "/api/onboarding", {
			mode: "join",
			inviteCode: created.tenant.inviteCode,
			displayName: "H2",
			handle,
		});
		await expectError(dup, 409, "HANDLE_TAKEN");
		// 事务已回滚：此人仍未入驻，可换 handle 重新加入。
		await expectError(
			await other.request("GET", "/api/me"),
			404,
			"NOT_ONBOARDED",
		);
		await onboardJoin(
			other,
			created.tenant.inviteCode as string,
			uniq("h"),
			"H2",
		);
	});

	it("handle 与同租户代理的 handle 冲突 → 409", async () => {
		const owner = await signUpAndIn();
		const handle = uniq("k");
		const created = await onboardCreate(owner, handle, "K");
		const other = await signUpAndIn();
		const dup = await other.request("POST", "/api/onboarding", {
			mode: "join",
			inviteCode: created.tenant.inviteCode,
			displayName: "K2",
			handle: `${handle}-twin`,
		});
		await expectError(dup, 409, "HANDLE_TAKEN");
	});

	it("不同租户可以用同一个 handle", async () => {
		const handle = uniq("s");
		await onboardCreate(await signUpAndIn(), handle, "S1");
		await onboardCreate(await signUpAndIn(), handle, "S2");
	});
});

describe("onboarding 400", () => {
	let c: Client;
	beforeAll(async () => {
		c = await signUpAndIn();
	});

	it.each([
		[
			"handle 不合规",
			{ mode: "create", orgName: "o", displayName: "A", handle: "Bad_Handle" },
		],
		["缺 orgName", { mode: "create", displayName: "A", handle: "abc" }],
		["未知 mode", { mode: "invite", displayName: "A", handle: "abc" }],
		[
			"空显示名",
			{ mode: "create", orgName: "o", displayName: "", handle: "abc" },
		],
	])("%s → 400 BAD_REQUEST", async (_name, body) => {
		await expectError(
			await c.request("POST", "/api/onboarding", body),
			400,
			"BAD_REQUEST",
		);
	});

	it("非 JSON 请求体 → 400", async () => {
		await expectError(
			await c.send("POST", "/api/onboarding", "{not json"),
			400,
			"BAD_REQUEST",
		);
	});

	it("邀请码不存在 → 400 INVITE_CODE_INVALID", async () => {
		const res = await c.request("POST", "/api/onboarding", {
			mode: "join",
			inviteCode: "NOSUCHCODE",
			displayName: "A",
			handle: "abc",
		});
		await expectError(res, 400, "INVITE_CODE_INVALID");
	});

	it("未 onboarding 访问 /api/me 与 /api/directory → 404 NOT_ONBOARDED", async () => {
		await expectError(await c.request("GET", "/api/me"), 404, "NOT_ONBOARDED");
		await expectError(
			await c.request("GET", "/api/directory"),
			404,
			"NOT_ONBOARDED",
		);
	});
});

describe("租户隔离", () => {
	it("别家公司的通讯录与 /api/me 只含本租户数据", async () => {
		const alice = await signUpAndIn("Alice");
		const dave = await signUpAndIn("Dave");
		const aliceHandle = uniq("al");
		const a = await onboardCreate(alice, aliceHandle, "Alice");
		const d = await onboardCreate(dave, uniq("dv"), "Dave");
		expect(d.tenant.id).not.toBe(a.tenant.id);

		const { people } = DirectoryResponseSchema.parse(
			await (await dave.request("GET", "/api/directory")).json(),
		);
		expect(people.map((p) => p.principal.id)).toEqual([d.principal.id]);
		expect(people.every((p) => p.principal.tenantId === d.tenant.id)).toBe(
			true,
		);
		expect(JSON.stringify(people)).not.toContain(aliceHandle);

		const me = MeResponseSchema.parse(
			await (await dave.request("GET", "/api/me")).json(),
		);
		expect(me.tenant.id).toBe(d.tenant.id);
		expect(me.agents.every((x) => x.principal.tenantId === d.tenant.id)).toBe(
			true,
		);
	});
});
