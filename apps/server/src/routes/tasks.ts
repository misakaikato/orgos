import {
	CreateTaskRequestSchema,
	isExternalAgent,
	TASK_LOG_PAGE_MAX,
	type TaskListResponse,
	TaskLogQuerySchema,
	type TaskLogResponse,
	type TaskResponse,
	TasksQuerySchema,
} from "@orgos/protocol";
import type { Hono } from "hono";
import type { Scoped } from "@/db/scope";
import { badRequest } from "@/lib/errors";
import { parseJson, parseQuery } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import { findAgent } from "@/services/agents";
import {
	memberPrincipals,
	postMessage,
	requireConversation,
} from "@/services/conversations";
import { externalTasks } from "@/services/external-tasks";
import {
	listTaskLogs,
	listTasks,
	requireOwnExternalTask,
	requireVisibleTask,
	taskAssignee,
} from "@/services/tasks";

async function taskBody(
	s: Scoped,
	task: TaskResponse["task"],
): Promise<TaskResponse> {
	const assignee = await taskAssignee(s, task);
	return { task, ...(assignee ? { assignee } : {}) };
}

/**
 * 任务：交办所在会话的成员可以查看任务与过程；外部助手的任务只有它的本人能完成或停止；
 * "新任务"只在本人与自己外部助手的私聊里可用。看不到的一律 404。
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
		const others = [
			...(await memberPrincipals(s, conversation.id)).values(),
		].filter((p) => p.id !== me.id);
		const [only] = others;
		const agent =
			conversation.kind === "dm" && others.length === 1 && only
				? await findAgent(s, { id: only.id })
				: null;
		if (
			!agent ||
			!isExternalAgent(agent) ||
			agent.principal.ownerId !== me.id
		) {
			throw badRequest("只能在与自己外部助手的私聊里开新任务");
		}
		await postMessage(s, me, conversation.id, { text: req.goal });
		const task = await externalTasks.startNew(
			s,
			agent,
			conversation.id,
			me.id,
			req.goal,
		);
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

	app.post("/api/tasks/:id/complete", async (c) => {
		const s = c.get("scope");
		const task = await requireOwnExternalTask(
			s,
			c.get("principal"),
			c.req.param("id"),
		);
		return c.json(await taskBody(s, await externalTasks.complete(s, task)));
	});

	app.post("/api/tasks/:id/cancel", async (c) => {
		const s = c.get("scope");
		const task = await requireOwnExternalTask(
			s,
			c.get("principal"),
			c.req.param("id"),
		);
		return c.json(await taskBody(s, await externalTasks.cancel(s, task)));
	});
}
