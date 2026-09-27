import {
	type CreateConversationResponse,
	CreateTopicRequestSchema,
	type TaskResponse,
	type TopicListResponse,
	type TopicResponse,
	type TopicSourceResponse,
	TopicToGroupRequestSchema,
	TopicToTaskRequestSchema,
	UpdateTopicRequestSchema,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { scheduler } from "@/agent/scheduler";
import { parseJson } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import { externalSessions } from "@/services/external-sessions";
import { taskAssignee } from "@/services/tasks";
import { topicSource, topicToGroup, topicToTask } from "@/services/topic-moves";
import {
	createTopic,
	describeTopic,
	listTopics,
	updateTopic,
} from "@/services/topics";

/**
 * 话题：会话成员可以看、开新话题、改名与归档（主线除外）；转为任务只在本人与自己代理的私聊里；
 * 转成群聊由本人拉人建新群。看不到的一律 404。
 */
export function registerTopicRoutes(app: Hono<AppEnv>): void {
	app.use("/api/topics/*", requireAuth, requireMember);

	app.get("/api/conversations/:id/topics", async (c) => {
		const body: TopicListResponse = {
			items: await listTopics(
				c.get("scope"),
				c.get("principal"),
				c.req.param("id"),
			),
		};
		return c.json(body);
	});

	app.post("/api/conversations/:id/topics", async (c) => {
		const { title } = await parseJson(c, CreateTopicRequestSchema);
		const s = c.get("scope");
		const row = await createTopic(
			s,
			c.get("principal"),
			c.req.param("id"),
			title,
		);
		const body: TopicResponse = { topic: await describeTopic(s, row) };
		return c.json(body, 201);
	});

	app.patch("/api/topics/:id", async (c) => {
		const req = await parseJson(c, UpdateTopicRequestSchema);
		const s = c.get("scope");
		const row = await updateTopic(
			s,
			c.get("principal"),
			c.req.param("id"),
			req,
		);
		if (req.archived) await externalSessions.onTopicArchived(s, row.id);
		const body: TopicResponse = { topic: await describeTopic(s, row) };
		return c.json(body);
	});

	app.post("/api/topics/:id/to-task", async (c) => {
		const { goal } = await parseJson(c, TopicToTaskRequestSchema);
		const s = c.get("scope");
		const me = c.get("principal");
		const { task, posted } = await topicToTask(s, me, c.req.param("id"), goal);
		if (posted?.type === "message.posted" && posted.actorId === me.id)
			void scheduler.onHumanMessage(s, posted);
		const assignee = await taskAssignee(s, task);
		const body: TaskResponse = { task, ...(assignee ? { assignee } : {}) };
		return c.json(body, 201);
	});

	app.post("/api/topics/:id/to-group", async (c) => {
		const req = await parseJson(c, TopicToGroupRequestSchema);
		const body: CreateConversationResponse = {
			conversation: await topicToGroup(
				c.get("scope"),
				c.get("principal"),
				c.req.param("id"),
				req,
			),
		};
		return c.json(body, 201);
	});

	app.get("/api/topics/:id/source", async (c) => {
		const body: TopicSourceResponse = await topicSource(
			c.get("scope"),
			c.get("principal"),
			c.req.param("id"),
		);
		return c.json(body);
	});
}
