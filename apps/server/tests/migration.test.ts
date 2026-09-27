/**
 * 集成：分身模型迁移（drizzle/0001_twin_model.sql）把 S2c 形态的旧数据改到新模型，且可重复执行。
 *
 * 旧数据用裸 SQL 造出（旧代码已不存在）：-chief 的 handle 与旧显示名、只有两人的真人私聊、
 * "找别人代理"的旁路私聊（本人为 observer，或更早的版本里本人不在其中）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
	agents,
	conversationMembers,
	conversations,
	principals,
} from "@/db/schema";
import { createTeam, type TeamMember } from "./helpers";

const MIGRATION = path.resolve(
	fileURLToPath(new URL("./", import.meta.url)),
	"../drizzle/0001_twin_model.sql",
);

async function runMigration(): Promise<void> {
	const statements = readFileSync(MIGRATION, "utf8")
		.split("--> statement-breakpoint")
		.map((x) => x.trim())
		.filter(Boolean);
	for (const statement of statements) await db.execute(sql.raw(statement));
}

function twinOf(m: TeamMember) {
	const a = m.me.agents.find((x) => x.role === "front");
	if (!a) throw new Error("缺少分身");
	return a.principal;
}
function opsOf(m: TeamMember) {
	const a = m.me.agents.find((x) => x.role === "specialist");
	if (!a) throw new Error("缺少助手");
	return a.principal;
}

async function legacyConversation(
	tenantId: string,
	createdBy: string,
	kind: "dm" | "group",
	members: { principalId: string; role: "member" | "observer" }[],
): Promise<string> {
	const [row] = await db
		.insert(conversations)
		.values({
			tenantId,
			kind,
			title: kind === "group" ? "旧群" : null,
			createdBy,
		})
		.returning();
	if (!row) throw new Error("建会话失败");
	for (const m of members) {
		await db
			.insert(conversationMembers)
			.values({ conversationId: row.id, tenantId, ...m });
	}
	return row.id;
}

async function membersOf(conversationId: string) {
	return db
		.select({
			principalId: conversationMembers.principalId,
			role: conversationMembers.role,
		})
		.from(conversationMembers)
		.where(eq(conversationMembers.conversationId, conversationId))
		.orderBy(asc(conversationMembers.principalId));
}

let mia: TeamMember;
let ned: TeamMember;
let oli: TeamMember;
const ids: Record<string, string> = {};

beforeAll(async () => {
	[mia, ned, oli] = (await createTeam(["Mia", "Ned", "Oli"])) as [
		TeamMember,
		TeamMember,
		TeamMember,
	];
	const tenantId = mia.me.tenant.id;
	for (const m of [mia, ned, oli]) {
		const name = m.me.principal.displayName;
		await db
			.update(principals)
			.set({
				handle: `${m.me.principal.handle}-chief`,
				displayName: `${name}的幕僚长`,
			})
			.where(eq(principals.id, twinOf(m).id));
		await db
			.update(principals)
			.set({ displayName: `${name}的执行助理` })
			.where(eq(principals.id, opsOf(m).id));
		await db
			.update(agents)
			.set({ description: `${name}的幕僚长，把事务分派给执行助理。` })
			.where(eq(agents.principalId, twinOf(m).id));
	}
	const H = (m: TeamMember) => m.me.principal.id;
	ids.pairMN = await legacyConversation(tenantId, H(mia), "dm", [
		{ principalId: H(mia), role: "member" },
		{ principalId: H(ned), role: "member" },
	]);
	ids.bypassOM = await legacyConversation(tenantId, H(oli), "dm", [
		{ principalId: H(oli), role: "member" },
		{ principalId: twinOf(mia).id, role: "member" },
		{ principalId: H(mia), role: "observer" },
	]);
	ids.pairNO = await legacyConversation(tenantId, H(ned), "dm", [
		{ principalId: H(ned), role: "member" },
		{ principalId: H(oli), role: "member" },
	]);
	ids.bypassNO = await legacyConversation(tenantId, H(ned), "dm", [
		{ principalId: H(ned), role: "member" },
		{ principalId: twinOf(oli).id, role: "member" },
		{ principalId: H(oli), role: "observer" },
	]);
	ids.bypassNoOwner = await legacyConversation(tenantId, H(ned), "dm", [
		{ principalId: H(ned), role: "member" },
		{ principalId: twinOf(mia).id, role: "member" },
	]);
	ids.own = await legacyConversation(tenantId, H(mia), "dm", [
		{ principalId: H(mia), role: "member" },
		{ principalId: twinOf(mia).id, role: "member" },
	]);
	ids.group = await legacyConversation(tenantId, H(mia), "group", [
		{ principalId: H(mia), role: "member" },
		{ principalId: H(ned), role: "member" },
		{ principalId: twinOf(ned).id, role: "member" },
	]);
});

async function snapshot() {
	const people = await db
		.select({
			id: principals.id,
			handle: principals.handle,
			displayName: principals.displayName,
			status: principals.status,
		})
		.from(principals)
		.where(eq(principals.tenantId, mia.me.tenant.id))
		.orderBy(asc(principals.id));
	const descriptions = await db
		.select({ id: agents.principalId, description: agents.description })
		.from(agents)
		.where(eq(agents.tenantId, mia.me.tenant.id))
		.orderBy(asc(agents.principalId));
	const members: Record<string, Awaited<ReturnType<typeof membersOf>>> = {};
	for (const [k, id] of Object.entries(ids)) members[k] = await membersOf(id);
	return { people, descriptions, members };
}

describe("0001_twin_model 迁移", () => {
	it("改名、补分身、并入旁路私聊；执行两次结果相同", async () => {
		await runMigration();
		const first = await snapshot();
		await runMigration();
		expect(await snapshot()).toEqual(first);

		const twins = await db
			.select()
			.from(principals)
			.where(
				inArray(principals.id, [
					twinOf(mia).id,
					twinOf(ned).id,
					twinOf(oli).id,
				]),
			);
		for (const t of twins) {
			expect(t.handle).toMatch(/-twin$/);
			expect(t.displayName).toMatch(/的分身$/);
		}
		const [miaOps] = await db
			.select()
			.from(principals)
			.where(eq(principals.id, opsOf(mia).id));
		expect(miaOps?.displayName).toBe("Mia的执行助手");
		const [desc] = await db
			.select()
			.from(agents)
			.where(eq(agents.principalId, twinOf(mia).id));
		expect(desc?.description).toBe("Mia的分身，把事务分派给执行助手。");
		const [human] = await db
			.select()
			.from(principals)
			.where(
				and(
					eq(principals.id, mia.me.principal.id),
					eq(principals.kind, "human"),
				),
			);
		expect(human?.status).toBe("available");

		const asMembers = (...list: string[]) =>
			list.sort().map((principalId) => ({ principalId, role: "member" }));
		const H = (m: TeamMember) => m.me.principal.id;
		expect(first.members.pairMN).toEqual(
			asMembers(H(mia), H(ned), twinOf(mia).id, twinOf(ned).id),
		);
		// 旁路私聊：Mia 转为成员、补上 Oli 的分身，成为两人私聊。
		expect(first.members.bypassOM).toEqual(
			asMembers(H(oli), H(mia), twinOf(mia).id, twinOf(oli).id),
		);
		expect(first.members.pairNO).toEqual(
			asMembers(H(ned), H(oli), twinOf(ned).id, twinOf(oli).id),
		);
		// 两人之间已有私聊：旁路会话保持原样。
		expect(first.members.bypassNO).toEqual(
			[
				{ principalId: H(ned), role: "member" },
				{ principalId: twinOf(oli).id, role: "member" },
				{ principalId: H(oli), role: "observer" },
			].sort((a, b) => (a.principalId < b.principalId ? -1 : 1)),
		);
		// 更早的旁路私聊（本人不在其中），但 Mia 与 Ned 已有私聊：保持原样。
		expect(first.members.bypassNoOwner).toEqual(
			asMembers(H(ned), twinOf(mia).id),
		);
		expect(first.members.own).toEqual(asMembers(H(mia), twinOf(mia).id));
		expect(first.members.group).toEqual(
			asMembers(H(mia), H(ned), twinOf(ned).id),
		);
	});

	it("迁移后，经接口再开同一对人的私聊得到迁移过的那个会话", async () => {
		const res = await mia.client.request("POST", "/api/conversations", {
			kind: "dm",
			withPrincipalId: ned.me.principal.id,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversation: { id: string } };
		expect(body.conversation.id).toBe(ids.pairMN);
	});
});
