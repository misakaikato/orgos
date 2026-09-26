import { ERROR_CODES } from "@orgos/protocol";
import type { MiddlewareHandler } from "hono";
import { auth } from "@/auth";
import {
	findMembership,
	type Member,
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
	};
};

/** 解析会话（cookie 或 `Authorization: Bearer`）；无效 → 401。 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) {
		throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "未登录");
	}
	c.set("user", {
		id: session.user.id,
		email: session.user.email,
		name: session.user.name,
	});
	await next();
};

/**
 * 在 requireAuth 之后使用：挂上成员身份与租户作用域。
 * 尚未 onboarding → 404 NOT_ONBOARDED。
 */
export const requireMember: MiddlewareHandler<AppEnv> = async (c, next) => {
	const found = await findMembership(c.get("user").id);
	if (!found) {
		throw new AppError(404, ERROR_CODES.NOT_ONBOARDED, "尚未加入任何组织");
	}
	c.set("member", found.member);
	c.set("tenant", found.tenant);
	c.set("scope", scoped(found.tenant.id));
	await next();
};
