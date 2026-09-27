/**
 * 人的在线状态：本人切换，变化以 `presence` 帧推给同租户的所有人。
 */
import type { Principal, PrincipalStatus } from "@orgos/protocol";
import { eq } from "drizzle-orm";
import { principals } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { notFound } from "@/lib/errors";
import { toPrincipal } from "@/lib/serialize";
import { browserHub } from "@/realtime/browser-hub";

export async function setStatus(
	s: Scoped,
	me: PrincipalRow,
	status: PrincipalStatus,
): Promise<Principal> {
	const [row] = await s.executor
		.update(principals)
		.set({ status })
		.where(
			s.where(
				principals,
				eq(principals.id, me.id),
				eq(principals.kind, "human"),
			),
		)
		.returning();
	if (!row) throw notFound("找不到此人");
	const colleagues = await s.select(principals, eq(principals.kind, "human"));
	browserHub.sendTo(
		colleagues.map((p) => p.id),
		{ t: "presence", principalId: row.id, status },
	);
	return toPrincipal(row);
}
