import { type MeResponse, MeResponseSchema } from "@orgos/protocol";
import { app } from "@/index";

const ORIGIN = process.env.BETTER_AUTH_URL ?? "http://localhost:8930";
export const PASSWORD = "test-password-123";

export function uniq(prefix: string): string {
	return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

/** 从响应里收集 set-cookie，拼成可回传的 Cookie 头。 */
function cookiesFrom(res: Response): string {
	return res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
}

export type Client = {
	email: string;
	/** 鉴权头（cookie 或 authorization），供 WS 等非 REST 场景复用。 */
	headers: Record<string, string>;
	/** body 为 JSON 值，序列化后发送。 */
	request(method: string, path: string, body?: unknown): Promise<Response>;
	/** 原样发送字符串请求体。 */
	send(method: string, path: string, rawBody: string): Promise<Response>;
};

function client(email: string, headers: Record<string, string>): Client {
	const send = async (
		method: string,
		path: string,
		rawBody?: string,
	): Promise<Response> =>
		app.request(path, {
			method,
			headers: {
				"content-type": "application/json",
				origin: ORIGIN,
				...headers,
			},
			body: rawBody,
		});
	return {
		email,
		headers,
		request: (method, path, body) =>
			send(method, path, body === undefined ? undefined : JSON.stringify(body)),
		send,
	};
}

export const anonymous: Client = client("", {});

/** 注册并登录一个新用户，返回带 cookie 的客户端。 */
export async function signUpAndIn(name = "Tester"): Promise<Client> {
	const email = `${uniq("u")}@orgos.test`;
	const up = await anonymous.request("POST", "/api/auth/sign-up/email", {
		email,
		password: PASSWORD,
		name,
	});
	if (up.status !== 200)
		throw new Error(`sign-up ${up.status}: ${await up.text()}`);
	const res = await anonymous.request("POST", "/api/auth/sign-in/email", {
		email,
		password: PASSWORD,
	});
	if (res.status !== 200)
		throw new Error(`sign-in ${res.status}: ${await res.text()}`);
	return client(email, { cookie: cookiesFrom(res) });
}

/** 以 bearer 插件签发的会话 token 访问。 */
export async function bearerClient(email: string): Promise<Client> {
	const res = await anonymous.request("POST", "/api/auth/sign-in/email", {
		email,
		password: PASSWORD,
	});
	const token = res.headers.get("set-auth-token");
	if (!token) throw new Error("sign-in 未返回 set-auth-token");
	return client(email, { authorization: `Bearer ${token}` });
}

export type TeamMember = { client: Client; me: MeResponse };

/**
 * 建一个租户：第一人创建组织，其余人用邀请码加入。返回各自的客户端与 /api/me。
 */
export async function createTeam(names: string[]): Promise<TeamMember[]> {
	const team: TeamMember[] = [];
	let inviteCode: string | undefined;
	for (const name of names) {
		const client = await signUpAndIn(name);
		const handle = uniq(name.toLowerCase().replace(/[^a-z]/g, "") || "p");
		const res = await client.request(
			"POST",
			"/api/onboarding",
			inviteCode
				? { mode: "join", inviteCode, displayName: name, handle }
				: { mode: "create", orgName: uniq("org-"), displayName: name, handle },
		);
		if (res.status !== 201)
			throw new Error(`onboarding ${res.status}: ${await res.text()}`);
		const me = MeResponseSchema.parse(
			await (await client.request("GET", "/api/me")).json(),
		);
		inviteCode ??= me.tenant.inviteCode;
		team.push({ client, me });
	}
	return team;
}
