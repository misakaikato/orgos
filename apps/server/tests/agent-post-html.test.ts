/**
 * 集成（MOCK_LLM=1）：post_html——代理发出 format=html、带摘要的消息，入库前清理；
 * 调用后本次运行随即结束（同一步随调用写的文字不发出）；为他人时记下提问人；
 * 超过 50KB 被拒；协商会话里不可用；预览与通知取摘要，模型与记忆看全文。
 */
import { ConversationListResponseSchema, previewTextOf } from "@orgos/protocol";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmRequest } from "@/agent/llm-types";
import { buildSystemPrompt } from "@/agent/prompt";
import { Scheduler, scheduler } from "@/agent/scheduler";
import { RunSession } from "@/agent/session";
import { availableTools } from "@/agent/tools";
import { HTML_MAX_BYTES, postHtmlTool } from "@/agent/tools/post-html";
import type { ToolScope } from "@/agent/tools/tool";
import { principals } from "@/db/schema";
import { type PrincipalRow, scoped } from "@/db/scope";
import { findAgent } from "@/services/agents";
import { postMessage } from "@/services/conversations";
import { actions, eventsOf, messagesBy, openDm, say } from "./agent-helpers";
import { createTeam, type TeamMember } from "./helpers";

let alice: TeamMember;
let bob: TeamMember;
let aliceTwin: string;
let ownDm: string;
let pairDm: string;

const tenant = () => scoped(alice.me.tenant.id);

beforeAll(async () => {
	[alice, bob] = (await createTeam(["Alice", "Bob"])) as [
		TeamMember,
		TeamMember,
	];
	aliceTwin =
		alice.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
	ownDm = await openDm(alice.client, aliceTwin);
	pairDm = await openDm(bob.client, alice.me.principal.id);
});

async function since(m: TeamMember, conversationId: string, afterId: number) {
	return (await eventsOf(m.client, conversationId)).filter(
		(e) => e.id > afterId,
	);
}

async function lastId(m: TeamMember, conversationId: string) {
	return (await eventsOf(m.client, conversationId)).at(-1)?.id ?? 0;
}

describe("post_html", () => {
	it("为本人：发出 format=html、带摘要的消息，脚本与事件属性已清理；本次不再另发 md", async () => {
		const after = await lastId(alice, ownDm);
		await say(
			alice.client,
			ownDm,
			'#html Q4 周报：迁移完成 70%|<h2 onclick="x()">Q4 周报</h2><script>alert(1)</script><p><a href="javascript:alert(1)">详情</a></p>',
		);
		const events = await since(alice, ownDm, after);
		const posted = messagesBy(events, aliceTwin);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.payload).toMatchObject({
			format: "html",
			summary: "Q4 周报：迁移完成 70%",
			text: "<h2>Q4 周报</h2><p><a>详情</a></p>",
		});
		expect(posted[0]?.onBehalfOfId).toBe(alice.me.principal.id);
		expect(posted[0]?.payload.askedById).toBeUndefined();
		expect(actions(events).map((a) => a.payload)).toEqual([
			{
				tool: "post_html",
				summary: "发了一条排版消息：Q4 周报：迁移完成 70%",
				ok: true,
			},
		]);
	});

	it("会话列表的最近一条经 previewTextOf 取到的是摘要", async () => {
		const res = await alice.client.request("GET", "/api/conversations");
		expect(res.status).toBe(200);
		const item = ConversationListResponseSchema.parse(
			await res.json(),
		).items.find((c) => c.conversation.id === ownDm);
		expect(item?.lastEvent?.type).toBe("message.posted");
		if (item?.lastEvent?.type !== "message.posted") return;
		expect(previewTextOf(item.lastEvent.payload)).toBe("Q4 周报：迁移完成 70%");
	});

	it("为他人：同样可用，消息记下提问人与所答的消息", async () => {
		const after = await lastId(bob, pairDm);
		const res = await bob.client.request(
			"POST",
			`/api/conversations/${pairDm}/messages`,
			{ text: "#html 排期卡片|<p>结算页 10 月 31 日上线</p>", askTwin: true },
		);
		expect(res.status).toBe(201);
		const { event: question } = (await res.json()) as {
			event: { id: number };
		};
		await scheduler.idle(pairDm);
		const posted = messagesBy(await since(bob, pairDm, after), aliceTwin);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.payload).toMatchObject({
			format: "html",
			summary: "排期卡片",
			text: "<p>结算页 10 月 31 日上线</p>",
			askedById: bob.me.principal.id,
			replyToEventId: question.id,
		});
	});

	it("调用后本次运行结束：只调用一次模型，同一步随调用写的文字不发出", async () => {
		const calls: LlmRequest[] = [];
		const llm: LlmClient = {
			async complete(req) {
				calls.push(req);
				return {
					text: "I have what I need. Assembling the report.",
					toolCalls: [
						{
							id: "c1",
							name: "post_html",
							arguments: JSON.stringify({
								summary: "周报",
								html: "<p>周报正文</p>",
							}),
						},
					],
					reasoning: false,
				};
			},
		};
		const sched = new Scheduler({ llm: () => llm });
		const after = await lastId(alice, ownDm);
		const me = await tenant().first(
			principals,
			eq(principals.id, alice.me.principal.id),
		);
		const event = await postMessage(tenant(), me as PrincipalRow, ownDm, {
			text: "做成能贴进邮件的周报",
		});
		if (event.type !== "message.posted") throw new Error("不是消息");
		await sched.onHumanMessage(tenant(), event);
		await sched.idle(ownDm);
		expect(calls).toHaveLength(1);
		const posted = messagesBy(await since(alice, ownDm, after), aliceTwin);
		expect(
			posted.map((m) => [m.payload.format, m.payload.text, m.payload.summary]),
		).toEqual([["html", "<p>周报正文</p>", "周报"]]);
	});
});

describe("html 消息：模型看全文，预览看摘要", () => {
	it("下一轮的模型输入里有 html 正文的细节，没有摘要；会话预览是摘要", async () => {
		const html =
			"<h2>周报</h2><table><tr><td>订单迁移</td><td>差异 38 笔</td></tr></table>";
		await say(alice.client, ownDm, `#html 本周要点|${html}`);
		const calls: LlmRequest[] = [];
		const llm: LlmClient = {
			async complete(req) {
				calls.push({ ...req, messages: [...req.messages] });
				return { text: "好的", toolCalls: [], reasoning: false };
			},
		};
		const sched = new Scheduler({ llm: () => llm });
		const me = await tenant().first(
			principals,
			eq(principals.id, alice.me.principal.id),
		);
		const event = await postMessage(tenant(), me as PrincipalRow, ownDm, {
			text: "差异多少笔？",
		});
		if (event.type !== "message.posted") throw new Error("不是消息");
		await sched.onHumanMessage(tenant(), event);
		await sched.idle(ownDm);
		const assistant = calls[0]?.messages.filter((m) => m.role === "assistant");
		const reportTurn = assistant?.find((m) => m.content?.includes("订单迁移"));
		expect(reportTurn?.content).toBe("周报\n订单迁移  差异 38 笔");

		const posted = messagesBy(
			await eventsOf(alice.client, ownDm),
			aliceTwin,
		).find((m) => m.payload.summary === "本周要点");
		expect(posted && previewTextOf(posted.payload)).toBe("本周要点");
	});
});

describe("post_html 的约束", () => {
	async function scopeFor(
		kind: "dm" | "group" | "negotiation",
		actingFor: ToolScope["actingFor"],
		conversationId = "c",
		topicId = "t",
	): Promise<ToolScope> {
		const agent = await findAgent(tenant(), { id: aliceTwin });
		const owner = await tenant().first(
			principals,
			eq(principals.id, alice.me.principal.id),
		);
		if (!agent || !owner) throw new Error("缺少分身");
		return {
			s: tenant(),
			agent,
			owner,
			unit: null,
			conversation: { id: conversationId, kind, topicId },
			runId: "r",
			actingFor,
			depth: 0,
			triggerEventId: null,
			session: new RunSession(),
			teammates: [],
			delegate: () => Promise.resolve({ outcome: "returned" as const }),
			startNegotiation: () => {},
		};
	}

	it("为本人、为他人都可用；协商会话里没有", async () => {
		const names = (s: ToolScope) => availableTools(s).map((t) => t.name);
		for (const actingFor of [
			{ kind: "owner" as const },
			{ kind: "other" as const, principalId: bob.me.principal.id },
		]) {
			expect(names(await scopeFor("dm", actingFor))).toContain("post_html");
			expect(names(await scopeFor("group", actingFor))).toContain("post_html");
			expect(names(await scopeFor("negotiation", actingFor))).not.toContain(
				"post_html",
			);
		}
	});

	it("系统提示说明何时用 post_html；协商会话的工具表里没有它", async () => {
		const scope = await scopeFor("dm", { kind: "owner" });
		const prompt = buildSystemPrompt({
			scope,
			tools: availableTools(scope),
			requesterName: null,
			conversationTitle: null,
			topicTitle: null,
			delegatedBy: null,
			resume: null,
		});
		expect(prompt).toContain(
			"用 post_html 发 HTML：只用内联样式，不引用外部资源",
		);
		expect(prompt).toContain("日常回复仍用 Markdown");
	});

	it("超过 50KB 被拒，不发消息；恰好 50KB 可以发", async () => {
		const topic = (await eventsOf(alice.client, ownDm)).at(-1)?.topicId ?? "";
		const scope = await scopeFor("dm", { kind: "owner" }, ownDm, topic);
		const after = await lastId(alice, ownDm);
		const fits = `<p>${"a".repeat(HTML_MAX_BYTES - "<p></p>".length)}</p>`;
		expect(new TextEncoder().encode(fits).length).toBe(HTML_MAX_BYTES);
		const rejected = await postHtmlTool.execute(
			{ summary: "太大", html: `${fits}字` },
			scope,
		);
		expect(rejected).toMatchObject({ ok: false });
		expect(rejected.result).toContain("50KB");
		expect(messagesBy(await since(alice, ownDm, after), aliceTwin)).toEqual([]);

		const ok = await postHtmlTool.execute(
			{ summary: "刚好", html: fits },
			scope,
		);
		expect(ok).toMatchObject({
			ok: true,
			replied: { html: fits, summary: "刚好" },
		});
	});

	it("摘要超过 60 字、为空，或 html 为空都被拒", async () => {
		const scope = await scopeFor("dm", { kind: "owner" });
		for (const args of [
			{ summary: "摘".repeat(61), html: "<p>x</p>" },
			{ summary: " ", html: "<p>x</p>" },
			{ summary: "摘要", html: "  " },
		]) {
			expect((await postHtmlTool.execute(args, scope)).ok).toBe(false);
		}
	});
});
