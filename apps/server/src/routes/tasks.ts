import {
	CreateTaskRequestSchema,
	TASK_LOG_PAGE_MAX,
	type Task,
	type TaskListResponse,
	TaskLogQuerySchema,
	type TaskLogResponse,
	type TaskResponse,
	TasksQuerySchema,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { scheduler } from "@/agent/scheduler";
import type { Scoped } from "@/db/scope";
import { parseJson, parseQuery } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import { requireConversation } from "@/services/conversations";
import { externalSessions } from "@/services/external-sessions";
import {
	listTaskLogs,
	listTasks,
	requireOwnOpenTask,
	requireTask,
	requireVisibleTask,
	taskAssignee,
	transitionTask,
} from "@/services/tasks";
import { newTaskTopic } from "@/services/topic-moves";

async function taskBody(s: Scoped, task: Task): Promise<TaskResponse> {
	const assignee = await taskAssignee(s, task);
	return { task, ...(assignee ? { assignee } : {}) };
}

/**
 * 任务：任务所在会话的成员与委托人可以查看任务与过程；只有执行者的本人能完成或停止；
 * "新任务"只在本人与自己代理的私聊里可用（新开一个任务话题）。看不到的一律 404。
 */
export function registerTaskRoutes(app: Hono<AppEnv>): void {
	app.use("/api/tasks", requireAuth, requireMember);
	app.use("/api/tasks/*", requireAuth, requireMember);

	app.get("/api/tasks", async (c) => {
		const query = parseQuery(c, TasksQuerySchema);
		const body: TaskListResponse = {
			items: await listTasks(c.get("scope"), c.get("principal"), query),
		};
		return c.json(body);
	});

	app.post("/api/tasks", async (c) => {
		const req = await parseJson(c, CreateTaskRequestSchema);
		const s = c.get("scope");
		const me = c.get("principal");
		const { conversation } = await requireConversation(
			s,
			req.conversationId,
			me.id,
		);
		const { task, posted } = await newTaskTopic(s, me, conversation, req.goal);
		if (posted.type === "message.posted")
			void scheduler.onHumanMessage(s, posted);
		return c.json(await taskBody(s, task), 201);
	});

	app.get("/api/tasks/:id", async (c) => {
		const s = c.get("scope");
		const task = await requireVisibleTask(
			s,
			c.get("principal"),
			c.req.param("id"),
		);
		return c.json(await taskBody(s, task));
	});

	app.get("/api/tasks/:id/log", async (c) => {
		const { after } = parseQuery(c, TaskLogQuerySchema);
		const s = c.get("scope");
		const task = await requireVisibleTask(
			s,
			c.get("principal"),
			c.req.param("id"),
		);
		const body: TaskLogResponse = {
			items: await listTaskLogs(s, task.id, after, TASK_LOG_PAGE_MAX),
		};
		return c.json(body);
	});

	/** 完成：任务结束，话题保留、可以接着聊。 */
	app.post("/api/tasks/:id/complete", async (c) => {
		const s = c.get("scope");
		const task = await requireOwnOpenTask(
			s,
			c.get("principal"),
			c.req.param("id"),
		);
		const done =
			(await transitionTask(s, task.id, "completed")) ??
			(await requireTask(s, task.id));
		return c.json(await taskBody(s, done));
	});

	/** 停止：任务取消，并打断任务话题里正在进行的这一轮。 */
	app.post("/api/tasks/:id/cancel", async (c) => {
		const s = c.get("scope");
		const task = await requireOwnOpenTask(
			s,
			c.get("principal"),
			c.req.param("id"),
		);
		const done =
			(await transitionTask(s, task.id, "canceled", { summary: "已停止" })) ??
			(await requireTask(s, task.id));
		scheduler.stop(task.conversationId, task.topicId);
		externalSessions.interrupt(task.conversationId, task.topicId);
		return c.json(await taskBody(s, done));
	});
}
