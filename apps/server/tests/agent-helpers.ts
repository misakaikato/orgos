/**
 * 代理引擎集成测试的共用动作：开会话、发消息并等调度结束、读事件、截获推送帧。
 */
import {
	type BrowserFrame,
	CreateConversationResponseSchema,
	type Event,
	EventsResponseSchema,
	type Topic,
	TopicListResponseSchema,
} from "@orgos/protocol";
import { expect } from "vitest";
import { scheduler } from "@/agent/scheduler";
import { browserHub } from "@/realtime/browser-hub";
import type { Client } from "./helpers";

export async function openDm(
	client: Client,
	withPrincipalId: string,
): Promise<string> {
	const res = await client.request("POST", "/api/conversations", {
		kind: "dm",
		withPrincipalId,
	});
	expect([200, 201]).toContain(res.status);
	return CreateConversationResponseSchema.parse(await res.json()).conversation
		.id;
}

export async function openGroup(
	client: Client,
	title: string,
	memberIds: string[],
): Promise<string> {
	const res = await client.request("POST", "/api/conversations", {
		kind: "group",
		title,
		memberIds,
	});
	expect(res.status).toBe(201);
	return CreateConversationResponseSchema.parse(await res.json()).conversation
		.id;
}

/** 发一条消息，并等这条消息引起的代理运行全部结束。 */
export async function say(
	client: Client,
	conversationId: string,
	text: string,
	opts: { mentions?: string[]; askTwin?: boolean } = {},
): Promise<void> {
	const res = await client.request(
		"POST",
		`/api/conversations/${conversationId}/messages`,
		{ text, ...opts },
	);
	expect(res.status).toBe(201);
	await scheduler.idle(conversationId);
}

export async function eventsOf(
	client: Client,
	conversationId: string,
): Promise<Event[]> {
	const res = await client.request(
		"GET",
		`/api/conversations/${conversationId}/events?limit=200`,
	);
	expect(res.status).toBe(200);
	return EventsResponseSchema.parse(await res.json()).items;
}

/** 会话的话题（主线在前，其余按最近活动倒序）。 */
export async function topicsOf(
	client: Client,
	conversationId: string,
): Promise<Topic[]> {
	const res = await client.request(
		"GET",
		`/api/conversations/${conversationId}/topics`,
	);
	expect(res.status).toBe(200);
	return TopicListResponseSchema.parse(await res.json()).items;
}

/** 某个话题的事件。 */
export async function topicEventsOf(
	client: Client,
	conversationId: string,
	topicId: string,
): Promise<Event[]> {
	const res = await client.request(
		"GET",
		`/api/conversations/${conversationId}/events?limit=200&topicId=${topicId}`,
	);
	expect(res.status).toBe(200);
	return EventsResponseSchema.parse(await res.json()).items;
}

/** 会话全部话题的事件，按 seq。 */
export async function allEventsOf(
	client: Client,
	conversationId: string,
): Promise<Event[]> {
	const all: Event[] = [];
	for (const t of await topicsOf(client, conversationId))
		all.push(...(await topicEventsOf(client, conversationId, t.id)));
	return all.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export type MessageEvent = Extract<Event, { type: "message.posted" }>;
export type ActionEvent = Extract<Event, { type: "agent.action" }>;

export function messagesBy(
	events: readonly Event[],
	actorId: string,
): MessageEvent[] {
	return events.filter(
		(e): e is MessageEvent =>
			e.type === "message.posted" && e.actorId === actorId,
	);
}

export function actions(events: readonly Event[]): ActionEvent[] {
	return events.filter((e): e is ActionEvent => e.type === "agent.action");
}

/** 截获推给某主体的全部帧。 */
export function captureFrames(principalId: string): {
	frames: BrowserFrame[];
	stop(): void;
} {
	const frames: BrowserFrame[] = [];
	const sock = {
		send: (data: string) => frames.push(JSON.parse(data) as BrowserFrame),
		close: () => {},
	};
	browserHub.attach(principalId, sock);
	return { frames, stop: () => browserHub.detach(principalId, sock) };
}
