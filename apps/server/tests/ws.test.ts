/**
 * 集成：浏览器 WS 的鉴权与推送。
 *
 * node 下的 vitest 没有 Bun 的升级能力：这里直接调用 `/ws` 路由所用的 browserWsEvents，
 * 以 hono 的 WSContext 包一个记录帧的假连接，鉴权（cookie / ?token=）、hub 登记与推送走真实路径。
 */
import {
	type BrowserFrame,
	CreateConversationResponseSchema,
	parseBrowserFrame,
	WS_CLOSE,
} from "@orgos/protocol";
import { WSContext } from "hono/ws";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserHub, browserHub } from "@/realtime/browser-hub";
import { browserWsEvents } from "@/realtime/browser-ws";
import {
	anonymous,
	createTeam,
	PASSWORD,
	signUpAndIn,
	type TeamMember,
} from "./helpers";

type FakeConn = {
	frames: BrowserFrame[];
	closed: { code?: number; reason?: string } | null;
	close(): void;
};

/** 以给定请求打开一条 /ws 连接，返回收到的帧与关闭状态。 */
async function connect(req: Request): Promise<FakeConn> {
	const events = await browserWsEvents(req);
	const conn: FakeConn = {
		frames: [],
		closed: null,
		close: () => events.onClose?.(new CloseEvent("close"), ws),
	};
	const ws = new WSContext({
		readyState: 1,
		send: (data) => {
			const parsed = parseBrowserFrame(String(data));
			if (!parsed.ok) throw new Error(parsed.error);
			conn.frames.push(parsed.data);
		},
		close: (code, reason) => {
			conn.closed = { code, reason };
		},
	});
	events.onOpen?.(new Event("open"), ws);
	return conn;
}

function wsRequest(headers: Record<string, string>, query = ""): Request {
	return new Request(`http://localhost:8930/ws${query}`, { headers });
}

const opened: FakeConn[] = [];
async function open(req: Request): Promise<FakeConn> {
	const conn = await connect(req);
	opened.push(conn);
	return conn;
}
afterEach(() => {
	for (const c of opened.splice(0)) c.close();
});

describe("鉴权", () => {
	it("未登录 → 以 4401 关闭，不登记", async () => {
		const conn = await open(wsRequest({}));
		expect(conn.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED);
	});

	it("无效 token → 4401", async () => {
		const conn = await open(wsRequest({}, "?token=not-a-real-token"));
		expect(conn.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED);
	});

	it("已登录未入驻 → 4404", async () => {
		const c = await signUpAndIn();
		const conn = await open(wsRequest(c.headers));
		expect(conn.closed?.code).toBe(WS_CLOSE.NOT_ONBOARDED);
	});

	it("cookie 与 ?token= 都能登记到本人主体；关闭后注销", async () => {
		const [m] = (await createTeam(["Wes"])) as [TeamMember];
		const id = m.me.principal.id;
		const byCookie = await open(wsRequest(m.client.headers));
		expect(byCookie.closed).toBeNull();
		expect(browserHub.connectionCount(id)).toBe(1);

		const signIn = await anonymous.request("POST", "/api/auth/sign-in/email", {
			email: m.client.email,
			password: PASSWORD,
		});
		const token = signIn.headers.get("set-auth-token");
		expect(token).toBeTruthy();
		const byToken = await open(
			wsRequest({}, `?token=${encodeURIComponent(token ?? "")}`),
		);
		expect(byToken.closed).toBeNull();
		expect(browserHub.connectionCount(id)).toBe(2);

		byCookie.close();
		byToken.close();
		expect(browserHub.connectionCount(id)).toBe(0);
	});

	it("cookie 与 ?token= 属于不同人时以 token 为准", async () => {
		const [x, y] = (await createTeam(["Xia", "Yan"])) as [
			TeamMember,
			TeamMember,
		];
		const signIn = await anonymous.request("POST", "/api/auth/sign-in/email", {
			email: y.client.email,
			password: PASSWORD,
		});
		const token = signIn.headers.get("set-auth-token") ?? "";
		const conn = await open(
			wsRequest(x.client.headers, `?token=${encodeURIComponent(token)}`),
		);
		expect(conn.closed).toBeNull();
		expect(browserHub.connectionCount(y.me.principal.id)).toBe(1);
		expect(browserHub.connectionCount(x.me.principal.id)).toBe(0);
	});
});

describe("推送", () => {
	let a: TeamMember;
	let b: TeamMember;
	let c: TeamMember;
	beforeAll(async () => {
		[a, b, c] = (await createTeam(["Ada", "Bea", "Cal"])) as [
			TeamMember,
			TeamMember,
			TeamMember,
		];
	});

	it("会话成员（含发送者的每个连接）收到 event，非成员收不到", async () => {
		const res = await a.client.request("POST", "/api/conversations", {
			kind: "dm",
			withPrincipalId: b.me.principal.id,
		});
		const { conversation } = CreateConversationResponseSchema.parse(
			await res.json(),
		);

		const aConn1 = await open(wsRequest(a.client.headers));
		const aConn2 = await open(wsRequest(a.client.headers));
		const bConn = await open(wsRequest(b.client.headers));
		const cConn = await open(wsRequest(c.client.headers));

		const sent = await a.client.request(
			"POST",
			`/api/conversations/${conversation.id}/messages`,
			{ text: "推送测试" },
		);
		expect(sent.status).toBe(201);

		for (const conn of [aConn1, aConn2, bConn]) {
			expect(conn.frames).toHaveLength(1);
			const [frame] = conn.frames;
			expect(frame?.t).toBe("event");
			if (frame?.t === "event") {
				expect(frame.event).toMatchObject({
					conversationId: conversation.id,
					seq: 1,
					type: "message.posted",
					payload: { text: "推送测试" },
				});
			}
		}
		expect(cConn.frames).toEqual([]);
	});

	it("被拉进群的新成员收到 member.joined", async () => {
		const cConn = await open(wsRequest(c.client.headers));
		const res = await a.client.request("POST", "/api/conversations", {
			kind: "group",
			title: "推送群",
			memberIds: [b.me.principal.id],
		});
		const { conversation } = CreateConversationResponseSchema.parse(
			await res.json(),
		);
		expect(cConn.frames).toEqual([]);

		const added = await a.client.request(
			"POST",
			`/api/conversations/${conversation.id}/members`,
			{ principalId: c.me.principal.id },
		);
		expect(added.status).toBe(201);
		expect(cConn.frames).toHaveLength(1);
		expect(cConn.frames[0]).toMatchObject({
			t: "event",
			event: {
				type: "member.joined",
				payload: { principalId: c.me.principal.id },
			},
		});
	});
});

describe("BrowserHub", () => {
	it("每 20s 向所有连接发 ping；单条连接发送失败不影响其他连接", () => {
		vi.useFakeTimers();
		try {
			const hub = new BrowserHub();
			const got: string[] = [];
			hub.attach("p1", {
				send: () => {
					throw new Error("gone");
				},
				close: () => {},
			});
			hub.attach("p2", { send: (d) => got.push(d), close: () => {} });
			hub.startPing();
			vi.advanceTimersByTime(19_999);
			expect(got).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(got).toEqual([JSON.stringify({ t: "ping" })]);
			hub.stopPing();
			vi.advanceTimersByTime(60_000);
			expect(got).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("detach 按对象引用匹配", () => {
		const hub = new BrowserHub();
		const sock = { send: () => {}, close: () => {} };
		hub.attach("p", sock);
		hub.detach("p", { ...sock });
		expect(hub.connectionCount("p")).toBe(1);
		hub.detach("p", sock);
		expect(hub.connectionCount("p")).toBe(0);
	});
});
