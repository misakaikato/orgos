import {
	AddMemberRequestSchema,
	type ConversationListResponse,
	CreateConversationRequestSchema,
	type CreateConversationResponse,
	EventsQuerySchema,
	type EventsResponse,
	MarkReadRequestSchema,
	PostMessageRequestSchema,
	type PostMessageResponse,
	StopQuerySchema,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { scheduler } from "@/agent/scheduler";
import { parseJson, parseQuery } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import {
	addMember,
	createGroup,
	listConversations,
	listEvents,
	markRead,
	openDm,
	postMessage,
	removeMember,
	requireConversation,
} from "@/services/conversations";
import { externalSessions } from "@/services/external-sessions";
import { topicIn } from "@/services/topics";

export function registerConversationRoutes(app: Hono<AppEnv>): void {
	app.use("/api/conversations", requireAuth, requireMember);
	app.use("/api/conversations/*", requireAuth, requireMember);

	app.get("/api/conversations", async (c) => {
		const body: ConversationListResponse = {
			items: await listConversations(c.get("scope"), c.get("principal")),
		};
		return c.json(body);
	});

	app.post("/api/conversations", async (c) => {
		const req = await parseJson(c, CreateConversationRequestSchema);
		const s = c.get("scope");
		const me = c.get("principal");
		if (req.kind === "dm") {
			const { conversation, created } = await openDm(
				s,
				me,
				req.withPrincipalId,
			);
			const body: CreateConversationResponse = { conversation };
			return c.json(body, created ? 201 : 200);
		}
		const { conversation } = await createGroup(s, me, req.title, req.memberIds);
		const body: CreateConversationResponse = { conversation };
		return c.json(body, 201);
	});

	app.get("/api/conversations/:id/events", async (c) => {
		const query = parseQuery(c, EventsQuerySchema);
		const body: EventsResponse = {
			items: await listEvents(
				c.get("scope"),
				c.get("principal"),
				c.req.param("id"),
				query,
			),
		};
		return c.json(body);
	});

	app.post("/api/conversations/:id/messages", async (c) => {
		const req = await parseJson(c, PostMessageRequestSchema);
		const s = c.get("scope");
		const event = await postMessage(
			s,
			c.get("principal"),
			c.req.param("id"),
			req,
		);
		if (event.type === "message.posted")
			void scheduler.onHumanMessage(s, event);
		const body: PostMessageResponse = { event };
		return c.json(body, 201);
	});

	app.post("/api/conversations/:id/members", async (c) => {
		const req = await parseJson(c, AddMemberRequestSchema);
		await addMember(
			c.get("scope"),
			c.get("principal"),
			c.req.param("id"),
			req.principalId,
		);
		return c.body(null, 201);
	});

	app.post("/api/conversations/:id/read", async (c) => {
		const req = await parseJson(c, MarkReadRequestSchema);
		await markRead(
			c.get("scope"),
			c.get("principal"),
			c.req.param("id"),
			req.seq,
		);
		return c.body(null, 204);
	});

	app.delete("/api/conversations/:id/members/:principalId", async (c) => {
		await removeMember(
			c.get("scope"),
			c.get("principal"),
			c.req.param("id"),
			c.req.param("principalId"),
		);
		return c.body(null, 204);
	});

	app.post("/api/conversations/:id/stop", async (c) => {
		const { topicId } = parseQuery(c, StopQuerySchema);
		const s = c.get("scope");
		const { conversation } = await requireConversation(
			s,
			c.req.param("id"),
			c.get("principal").id,
		);
		const topic = topicId ? await topicIn(s, conversation.id, topicId) : null;
		scheduler.stop(conversation.id, topic?.id);
		externalSessions.interrupt(conversation.id, topic?.id);
		return c.body(null, 204);
	});
}
