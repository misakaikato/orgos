/**
 * 集成：话题迁移（drizzle/0003_topics_runs.sql）把 S6b 形态的旧数据归入话题，且可重复执行。
 *
 * 旧数据用裸 SQL 造出（旧代码已不存在）：先放开 events / tasks 的 topic_id 非空约束，
 * 再插入没有主线的会话、没有话题的事件与任务、缺分身的群；迁移会把非空约束恢复。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
	conversationMembers,
	conversations,
	events,
	tasks,
	topics,
} from "@/db/schema";
import { createTeam, type TeamMember } from "./helpers";

const MIGRATION = path.resolve(
	fileURLToPath(new URL("./", import.meta.url)),
	"../drizzle/0003_topics_runs.sql",
);

async function runMigration(): Promise<void> {
	const statements = readFileSync(MIGRATION, "utf8")
		.split("--> statement-breakpoint")
		.map((x) => x.trim())
		.filter(Boolean);
	for (const statement of statements) await db.execute(sql.raw(statement));
}

const agentOf = (m: TeamMember, role: "front" | "specialist") => {
	const a = m.me.agents.find((x) => x.role === role);
	if (!a) throw new Error(`缺少 ${role}`);
	return a.principal.id;
};

let mia: TeamMember;
let ned: TeamMember;
let oli: TeamMember;
let tenantId: string;
const ids: Record<string, string> = {};

async function legacyConversation(
	kind: "dm" | "group",
	createdBy: string,
	members: string[],
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
	for (const principalId of members)
		await db.insert(conversationMembers).values({
			conversationId: row.id,
			tenantId,
			principalId,
			role: "member",
		});
	return row.id;
}

let seqOf: Record<string, number> = {};

async function legacyEvent(
	conversationId: string,
	actorId: string,
	type: string,
	payload: unknown,
): Promise<number> {
	seqOf[conversationId] = (seqOf[conversationId] ?? 0) + 1;
	const seq = seqOf[conversationId];
	await db.execute(
		sql`update conversations set last_seq = ${seq} where id = ${conversationId}`,
	);
	const rows = await db.execute<{ id: number }>(
		sql`insert into events (tenant_id, conversation_id, seq, type, actor_id, payload)
			values (${tenantId}, ${conversationId}, ${seq}, ${type}, ${actorId}, ${JSON.stringify(payload)}::jsonb)
			returning id`,
	);
	return Number(rows[0]?.id);
}

beforeAll(async () => {
	[mia, ned, oli] = (await createTeam(["Mia", "Ned", "Oli"])) as [
		TeamMember,
		TeamMember,
		TeamMember,
	];
	tenantId = mia.me.tenant.id;
	seqOf = {};
	await db.execute(sql`alter table events alter column topic_id drop not null`);
	await db.execute(sql`alter table tasks alter column topic_id drop not null`);
	const H = (m: TeamMember) => m.me.principal.id;
	ids.pair = await legacyConversation("dm", H(mia), [
		H(mia),
		H(ned),
		agentOf(mia, "front"),
		agentOf(ned, "front"),
	]);
	ids.group = await legacyConversation("group", H(mia), [
		H(mia),
		H(ned),
		H(oli),
		agentOf(ned, "front"),
	]);
	ids.ops = await legacyConversation("dm", H(mia), [
		H(mia),
		agentOf(mia, "specialist"),
	]);
	await legacyEvent(ids.pair, H(ned), "message.posted", {
		text: "旧私聊",
		mentions: [],
	});
	await legacyEvent(ids.group, H(mia), "member.joined", {
		principalId: H(ned),
	});
	const ops = agentOf(mia, "specialist");
	const [task] = await db.execute<{ id: string }>(
		sql`insert into tasks (tenant_id, conversation_id, requester_id, assignee_id, on_behalf_of_id,
				title, goal, state, engine)
			values (${tenantId}, ${ids.ops}, ${H(mia)}, ${ops}, ${H(mia)}, '旧任务', '旧任务', 'input_required', 'builtin')
			returning id`,
	);
	ids.task = task?.id ?? "";
	await legacyEvent(ids.ops, H(mia), "message.posted", {
		text: "帮我做个旧任务",
		mentions: [],
	});
	ids.taskCreated = String(
		await legacyEvent(ids.ops, ops, "task.created", {
			taskId: ids.task,
			title: "旧任务",
		}),
	);
	const wi = crypto.randomUUID();
	ids.approvalRequested = String(
		await legacyEvent(ids.ops, ops, "approval.requested", {
			workItemId: wi,
			runnerId: crypto.randomUUID(),
			runnerName: "旧设备",
			capability: "agent.acp",
			args: {},
			taskId: ids.task,
		}),
	);
	ids.approvalResolved = String(
		await legacyEvent(ids.ops, H(mia), "approval.resolved", {
			workItemId: wi,
			outcome: "approve",
		}),
	);
	ids.later = String(
		await legacyEvent(ids.ops, ops, "message.posted", {
			text: "做完了",
			mentions: [],
		}),
	);
});

async function snapshot() {
	const convIds = [ids.pair, ids.group, ids.ops] as string[];
	const topicRows = await db
		.select({
			id: topics.id,
			conversationId: topics.conversationId,
			kind: topics.kind,
			isMain: topics.isMain,
			taskId: topics.taskId,
			title: topics.title,
		})
		.from(topics)
		.where(inArray(topics.conversationId, convIds))
		.orderBy(asc(topics.conversationId), asc(topics.isMain), asc(topics.id));
	const eventRows = await db
		.select({ id: events.id, topicId: events.topicId })
		.from(events)
		.where(inArray(events.conversationId, convIds))
		.orderBy(asc(events.id));
	const taskRows = await db
		.select({ id: tasks.id, topicId: tasks.topicId })
		.from(tasks)
		.where(eq(tasks.tenantId, tenantId));
	const memberRows = await db
		.select({
			conversationId: conversationMembers.conversationId,
			principalId: conversationMembers.principalId,
		})
		.from(conversationMembers)
		.where(inArray(conversationMembers.conversationId, convIds))
		.orderBy(
			asc(conversationMembers.conversationId),
			asc(conversationMembers.principalId),
		);
	return { topicRows, eventRows, taskRows, memberRows };
}

describe("0003_topics_runs 迁移", () => {
	it("每个会话补一个主线、任务各成一个任务话题、事件归入对应话题、群补齐分身；执行两次结果相同", async () => {
		await runMigration();
		const first = await snapshot();
		await runMigration();
		expect(await snapshot()).toEqual(first);

		for (const id of [ids.pair, ids.group, ids.ops]) {
			const mains = first.topicRows.filter(
				(t) => t.conversationId === id && t.isMain,
			);
			expect(mains).toHaveLength(1);
			expect(mains[0]).toMatchObject({ kind: "chat", title: "主线" });
		}
		const taskTopic = first.topicRows.find((t) => t.taskId === ids.task);
		expect(taskTopic).toMatchObject({
			conversationId: ids.ops,
			kind: "task",
			isMain: false,
			title: "旧任务",
		});
		expect(first.taskRows).toEqual([{ id: ids.task, topicId: taskTopic?.id }]);
		const mainOf = (cid: string) =>
			first.topicRows.find((t) => t.conversationId === cid && t.isMain)?.id;
		const topicOf = (eventId: string) =>
			first.eventRows.find((e) => e.id === Number(eventId))?.topicId;
		expect(topicOf(ids.taskCreated ?? "")).toBe(taskTopic?.id);
		expect(topicOf(ids.approvalRequested ?? "")).toBe(taskTopic?.id);
		expect(topicOf(ids.approvalResolved ?? "")).toBe(taskTopic?.id);
		expect(topicOf(ids.later ?? "")).toBe(mainOf(ids.ops ?? ""));
		expect(first.eventRows.every((e) => e.topicId !== null)).toBe(true);

		const groupMembers = first.memberRows
			.filter((m) => m.conversationId === ids.group)
			.map((m) => m.principalId)
			.sort();
		expect(groupMembers).toEqual(
			[
				mia.me.principal.id,
				ned.me.principal.id,
				oli.me.principal.id,
				agentOf(mia, "front"),
				agentOf(ned, "front"),
				agentOf(oli, "front"),
			].sort(),
		);
		// 私聊不受"群补分身"影响。
		expect(
			first.memberRows.filter((m) => m.conversationId === ids.ops),
		).toHaveLength(2);
	});

	it("迁移后 topic_id 恢复非空；同一会话不能有第二个主线", async () => {
		const noTopic = await db
			.execute(
				sql`insert into events (tenant_id, conversation_id, seq, type, actor_id, payload)
					values (${tenantId}, ${ids.pair}, 999, 'message.posted', ${mia.me.principal.id}, '{}'::jsonb)`,
			)
			.catch((e: unknown) => e);
		expect(String((noTopic as Error).cause ?? noTopic)).toContain("topic_id");
		const secondMain = await db
			.insert(topics)
			.values({
				tenantId,
				conversationId: ids.pair ?? "",
				title: "又一个主线",
				isMain: true,
				createdBy: mia.me.principal.id,
			})
			.catch((e: unknown) => e);
		expect(String((secondMain as Error).cause ?? secondMain)).toContain(
			"topics_one_main_per_conversation",
		);
		const [row] = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(topics)
			.where(
				and(eq(topics.conversationId, ids.pair ?? ""), eq(topics.isMain, true)),
			);
		expect(row?.n).toBe(1);
	});
});
