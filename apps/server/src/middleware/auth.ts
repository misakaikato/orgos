import { ERROR_CODES } from "@orgos/protocol";
import type { MiddlewareHandler } from "hono";
import { auth } from "@/auth";
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

/** 解析会话；无效 → 401。 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
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
