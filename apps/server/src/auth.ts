import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { db } from "@/db";
import { account, session, user, verification } from "@/db/auth-schema";
import { env } from "@/env";

/**
 * better-auth：邮箱 + 密码登录；bearer 插件让 `Authorization: Bearer <会话 token>` 与 cookie 等价。
 *
 * schema 映射必须显式传：drizzle adapter 据此使用知晓 snake_case 列名的表对象，
 * 缺省时按 camelCase 列名查询会 500。
 */
export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		schema: { user, session, account, verification },
	}),
	baseURL: env.BETTER_AUTH_URL,
	// 本地经 127.0.0.1 访问与 localhost 等价。
	trustedOrigins: [env.BETTER_AUTH_URL.replace("//localhost", "//127.0.0.1")],
	secret: env.BETTER_AUTH_SECRET,
	emailAndPassword: {
		enabled: true,
		autoSignIn: false,
		minPasswordLength: 8,
		requireEmailVerification: false,
	},
	plugins: [bearer()],
});
