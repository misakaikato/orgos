/**
 * 本地测试账号（幂等）：租户"测试公司"（alice 为 owner，bob、carol 以邀请码加入）与"别家公司"（dave）。
 * 全部经 better-auth 注册与 onboarding 服务函数写入，与线上路径一致。
 *
 * 运行：bun run seed（需先 bun run dev:db && bun run db:migrate）。
 */
import { auth } from "@/auth";
import { closeDb } from "@/db";
import { findMembership, findUserIdByEmail } from "@/db/scope";
import { onboard } from "@/services/onboarding";

/** 测试密码：仅限本地开发库使用。 */
const SEED_PASSWORD = "orgos-local-pass";

const SEED_TENANTS = [
	{
		orgName: "测试公司",
		people: [
			{ handle: "alice", displayName: "Alice" },
			{ handle: "bob", displayName: "Bob" },
			{ handle: "carol", displayName: "Carol" },
		],
	},
	{
		orgName: "别家公司",
		people: [{ handle: "dave", displayName: "Dave" }],
	},
] as const;

function seedEmail(handle: string): string {
	return `${handle}@orgos.local`;
}

async function ensureUser(email: string, name: string): Promise<string> {
	const existing = await findUserIdByEmail(email);
	if (existing) return existing;
	const res = await auth.api.signUpEmail({
		body: { email, password: SEED_PASSWORD, name },
	});
	return res.user.id;
}

async function seed(): Promise<void> {
	for (const t of SEED_TENANTS) {
		let inviteCode: string | undefined;
		for (const [i, person] of t.people.entries()) {
			const userId = await ensureUser(
				seedEmail(person.handle),
				person.displayName,
			);
			const found = await findMembership(userId);
			if (found) {
				if (i === 0) inviteCode = found.tenant.inviteCode;
				continue;
			}
			if (i === 0) {
				const res = await onboard(userId, {
					mode: "create",
					orgName: t.orgName,
					displayName: person.displayName,
					handle: person.handle,
				});
				inviteCode = res.tenant.inviteCode;
			} else {
				if (!inviteCode) throw new Error(`${t.orgName} 缺少 owner 的邀请码`);
				await onboard(userId, {
					mode: "join",
					inviteCode,
					displayName: person.displayName,
					handle: person.handle,
				});
			}
		}
		const handles = t.people.map((p) => p.handle).join("、");
		console.log(`[seed] ${t.orgName}：${handles}（邀请码 ${inviteCode}）`);
	}
	console.log(`[seed] 登录：<handle>@orgos.local / ${SEED_PASSWORD}`);
}

try {
	await seed();
} finally {
	await closeDb();
}
