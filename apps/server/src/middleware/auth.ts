import { ERROR_CODES } from "@orgos/protocol";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { auth } from "@/auth";
import { db } from "@/db";
import { user } from "@/db/auth-schema";
import {
	findMembership,
	findSelfPrincipal,
	type Member,
	type PrincipalRow,
	type Scoped,
	scoped,
	type Tenant,
} from "@/db/scope";
import { AppError } from "@/lib/errors";
import { type AgentDelegation, actingAsAgent } from "@/services/events";

export type SessionUser = { id: string; email: string; name: string };

export type AppEnv = {
	Variables: {
		user: SessionUser;
		member: Member;
		tenant: Tenant;
		scope: Scoped;
		/** 当前用户的本人主体（kind=human）。 */
		principal: PrincipalRow;
	};
};

/**
 * 由请求头解析登录用户（cookie 或 `Authorization: Bearer`）；未登录返回 null。
 * 两者同时出现时以显式的 bearer 为准：同源页面总会带上 cookie，
 * 而 bearer 插件只是把 token 追加成第二个会话 cookie，不去掉的话生效的是原 cookie。
 */
export async function sessionUserOf(
	headers: Headers,
): Promise<SessionUser | null> {
	if (headers.get("authorization")?.startsWith("Bearer ")) {
		headers = new Headers(headers);
		headers.delete("cookie");
	}
	const session = await auth.api.getSession({ headers });
	if (!session) return null;
	return {
		id: session.user.id,
		email: session.user.email,
		name: session.user.name,
	};
}

/**
 * 进程内调用的上下文：代理替本人调用应用接口时，经 `app.request` 的 env 参数传入。
 * 键是本模块私有的 Symbol，只能由 `internalCallEnv` 构造；网络请求的 env 由运行时给出，伪造不了。
 */
const INTERNAL_CALLER = Symbol("orgos.internal-caller");

type InternalCaller = { user: SessionUser; delegation: AgentDelegation };
type InternalEnv = { [INTERNAL_CALLER]: InternalCaller };

function internalCallerOf(env: unknown): InternalCaller | null {
	if (typeof env !== "object" || env === null || !(INTERNAL_CALLER in env))
		return null;
	return (env as InternalEnv)[INTERNAL_CALLER];
}

/** 代理 `agentId` 替本人（kind=human）调用应用接口时用的 env：请求者即本人。 */
export async function internalCallEnv(
	agentId: string,
	owner: PrincipalRow,
): Promise<InternalEnv> {
	if (owner.kind !== "human" || !owner.userId)
		throw new Error("只有个人代理能调用应用接口");
	const [row] = await db
		.select({ id: user.id, email: user.email, name: user.name })
		.from(user)
		.where(eq(user.id, owner.userId));
	if (!row) throw new Error("本人的登录账号不存在");
	return {
		[INTERNAL_CALLER]: {
			user: row,
			delegation: { agentId, ownerId: owner.id },
		},
	};
}

/**
 * 解析会话；无效 → 401。进程内调用以代理的本人为请求者，其后写下的事件带代办标记。
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
	const internal = internalCallerOf(c.env);
	if (internal) {
		c.set("user", internal.user);
		await actingAsAgent(internal.delegation, next);
		return;
	}
	const user = await sessionUserOf(c.req.raw.headers);
	if (!user) {
		throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "未登录");
	}
	c.set("user", user);
	await next();
};

/** 用户的成员身份、租户作用域与本人主体；尚未 onboarding 返回 null。 */
export async function identityOf(userId: string): Promise<{
	member: Member;
	tenant: Tenant;
	scope: Scoped;
	principal: PrincipalRow;
} | null> {
	const found = await findMembership(userId);
	if (!found) return null;
	const scope = scoped(found.tenant.id);
	const principal = await findSelfPrincipal(scope, userId);
	if (!principal) return null;
	return { ...found, scope, principal };
}

/**
 * 在 requireAuth 之后使用：挂上成员身份、租户作用域与本人主体。
 * 尚未 onboarding → 404 NOT_ONBOARDED。
 */
export const requireMember: MiddlewareHandler<AppEnv> = async (c, next) => {
	const found = await identityOf(c.get("user").id);
	if (!found) {
		throw new AppError(404, ERROR_CODES.NOT_ONBOARDED, "尚未加入任何组织");
	}
	c.set("member", found.member);
	c.set("tenant", found.tenant);
	c.set("scope", found.scope);
	c.set("principal", found.principal);
	await next();
};
