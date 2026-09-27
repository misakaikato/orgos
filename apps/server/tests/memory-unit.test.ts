/**
 * 单元：记忆层的纯函数——凭据清洗、检索词项、提炼输出的校验、回复引用的解析、第三人抹名、
 * 资料的可见范围、画像的重建时机、假模型的提炼与画像。
 */
import { describe, expect, it } from "vitest";
import { mockDecide } from "@/agent/mock-llm";
import type { PrincipalRow } from "@/db/scope";
import { scopeOfNote, withoutNames } from "@/memory/access";
import { extractCitations, stripCitationMarks } from "@/memory/citations";
import {
	type ExtractionContext,
	validateExtraction,
} from "@/memory/extract-prompt";
import { profileDue } from "@/memory/profiles";
import {
	coverage,
	scrubSecrets,
	similarity,
	termSet,
	terms,
} from "@/memory/text";

const ALICE = "00000000-0000-4000-8000-00000000000a";
const CAROL = "00000000-0000-4000-8000-00000000000c";
const CONV = "00000000-0000-4000-8000-0000000000f1";
const TOPIC = "00000000-0000-4000-8000-0000000000f2";

function human(id: string, handle: string, name: string): PrincipalRow {
	return {
		id,
		tenantId: CONV,
		kind: "human",
		userId: "u",
		ownerId: null,
		handle,
		displayName: name,
		status: "available",
		createdAt: new Date(),
	};
}

describe("凭据清洗", () => {
	it.each([
		["key 是 sk-abcdefghijklmnopqrstuv 别外传", "sk-abcdefghijklmnopqrstuv"],
		["Authorization: Bearer abcdef123456789", "abcdef123456789"],
		[
			"令牌 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
			"eyJhbGciOiJIUzI1NiJ9",
		],
		["测试库密码: hunter2secret 已更新", "hunter2secret"],
		["password=Pa55word!", "Pa55word!"],
		[
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
			"MIIEow",
		],
	])("%s → 抹去", (text, secret) => {
		const out = scrubSecrets(text);
		expect(out).not.toContain(secret);
		expect(out).toMatch(/«已抹去 \d+ 字符»/);
	});

	it("不误伤普通内容；键名保留", () => {
		expect(scrubSecrets("订单服务 10 月 20 日切流")).toBe(
			"订单服务 10 月 20 日切流",
		);
		expect(scrubSecrets("密码: abc12345")).toBe("密码: «已抹去 8 字符»");
	});
});

describe("检索词项", () => {
	it("中文按字二元组、英文按词、单字自成一项", () => {
		expect(terms("订单服务 Q4 切流")).toEqual([
			"订单",
			"单服",
			"服务",
			"q4",
			"切流",
		]);
		expect(terms("天")).toEqual(["天"]);
	});

	it("覆盖率与相似度", () => {
		expect(coverage(termSet("切流日期"), "10 月 20 日切流")).toBeCloseTo(1 / 3);
		expect(coverage(termSet("预算"), "Q4 预算口径：不含税")).toBe(1);
		expect(similarity("星火项目完成 80%", "星火项目完成 80%")).toBe(1);
		expect(similarity("星火项目", "订单服务")).toBe(0);
	});
});

describe("提炼输出的校验", () => {
	const candidate = {
		id: "abcd1234-0000-4000-8000-000000000001",
		subjectId: ALICE,
		category: "排期与交付",
		ownerCorrected: false,
	};
	const ctx: ExtractionContext = {
		events: new Map([[101, { conversationId: CONV, topicId: TOPIC }]]),
		subjects: new Map([
			["alice", human(ALICE, "alice", "Alice")],
			["carol", human(CAROL, "carol", "Carol")],
		]),
		candidates: new Map([
			["abcd1234", candidate as never],
			[
				"ffff0000",
				{ ...candidate, id: "ffff0000-0000", ownerCorrected: true } as never,
			],
		]),
	};
	const ok = {
		subject: "alice",
		kind: "progress",
		category: "项目进展",
		content: "星火项目完成 80%",
		sources: [101],
	};
	const run = (item: Record<string, unknown>) =>
		validateExtraction({ items: [{ ...ok, ...item }] }, ctx);

	it("合法条目通过，出处补上会话与话题", () => {
		expect(run({})).toEqual([
			expect.objectContaining({
				subjectId: ALICE,
				kind: "progress",
				category: "项目进展",
				sources: [
					{ kind: "event", id: "101", conversationId: CONV, topicId: TOPIC },
				],
				supersedes: [],
			}),
		]);
	});

	it.each([
		["伪造的出处", { sources: [999] }],
		["真假混杂的出处", { sources: [101, 999] }],
		["没有出处", { sources: [] }],
		["kind 不在白名单", { kind: "gossip" }],
		["category 不在白名单", { category: "八卦" }],
		["subject 不在这段交流里", { subject: "dave" }],
		["action=skip", { action: "skip" }],
		["内容为空", { content: "  " }],
	])("%s → 丢弃", (_label, patch) => {
		expect(run(patch)).toEqual([]);
	});

	it("取代：须是同一 subject 与类别的候选、且不是本人更正过的，否则按新增", () => {
		const as = (supersedes: string, category = "排期与交付") =>
			run({ action: "supersede", supersedes, category })[0]?.supersedes;
		expect(as("abcd1234")).toEqual([candidate.id]);
		expect(as("M:abcd1234")).toEqual([candidate.id]);
		expect(as("[M:abcd1234]")).toEqual([candidate.id]);
		expect(as("abcd1234", "项目进展")).toEqual([]);
		expect(as("ffff0000")).toEqual([]);
		expect(as("00000000")).toEqual([]);
	});

	it("不是对象或没有 items → 空", () => {
		expect(validateExtraction(null, ctx)).toEqual([]);
		expect(validateExtraction({ items: "x" }, ctx)).toEqual([]);
	});
});

describe("回复里的引用", () => {
	const id = "0123abcd-0000-4000-8000-000000000001";
	const citable = new Map([
		["[M:0123abcd]", { id, content: "切流 10 月 20 日" }],
	]);

	it("认识的解析为依据，编造的去掉；正文不留标记", () => {
		const out = extractCitations(
			"切流定在 10 月 20 日 [M:0123abcd]。另外 [M:deadbeef]",
			citable,
		);
		expect(out.citations).toEqual([{ id, content: "切流 10 月 20 日" }]);
		expect(out.text).toBe("切流定在 10 月 20 日。另外");
	});

	it("没有标记的文本原样保留（含连续空格）", () => {
		expect(stripCitationMarks("a.txt  7 B")).toBe("a.txt  7 B");
	});
});

describe("第三人与可见范围", () => {
	it("抹掉第三人的姓名与 handle", () => {
		expect(
			withoutNames("和 Carol 确认进度，@carol 负责", [
				{ displayName: "Carol", handle: "carol" },
			]),
		).toBe("和 同事 确认进度，同事 负责");
	});

	it("资料：私有 → 仅本人，共享 → 全员", () => {
		expect(scopeOfNote({ ownerId: ALICE, visibility: "private" })).toEqual({
			kind: "owner",
			principalIds: [ALICE],
		});
		expect(scopeOfNote({ ownerId: ALICE, visibility: "shared" })).toEqual({
			kind: "tenant",
		});
	});
});

describe("画像的重建时机", () => {
	const now = new Date("2026-09-27T12:00:00Z");
	const stat = (p: Partial<Parameters<typeof profileDue>[0]>) => ({
		subjectId: ALICE,
		active: 0,
		changed: 0,
		retracted: 0,
		builtAt: null,
		...p,
	});
	it.each([
		[stat({ active: 9, changed: 9 }), false],
		[stat({ active: 10, changed: 10 }), true],
		[stat({ builtAt: now, changed: 9 }), false],
		[stat({ builtAt: now, changed: 10 }), true],
		[stat({ builtAt: now, retracted: 1, changed: 1 }), true],
		[stat({ builtAt: new Date(now.getTime() - 86_400_000), changed: 1 }), true],
		[
			stat({ builtAt: new Date(now.getTime() - 86_400_000), changed: 0 }),
			false,
		],
	])("%o → %s", (s, due) => {
		expect(profileDue(s, now)).toBe(due);
	});
});

describe("假模型：提炼与画像", () => {
	const trigger = (memory: "extract" | "profile") => ({
		text: "",
		mentions: [],
		agent: { id: "system", handle: "system" },
		conversationKind: "dm" as const,
		memory,
	});

	it("#fact 产出对应条目；|supersede 取代同 subject 同类别的最后一个候选", () => {
		const user = [
			"已有记忆：",
			"[M:aaaa1111] @alice｜排期与交付｜旧的日期",
			"对话材料：",
			"[E7] @alice Alice：#fact 项目进展|星火项目完成 80%",
			"[E8] @alice 的代理「Alice的分身」：收到",
			"[E9] @carol Carol：#fact 排期与交付|改到 10 月 25 日|supersede",
			"[E10] @alice Alice：#fact 排期与交付|改到 10 月 26 日|supersede",
		].join("\n");
		const res = mockDecide(trigger("extract"), [
			{ role: "system", content: "" },
			{ role: "user", content: user },
		]);
		expect(res.kind).toBe("text");
		const out = JSON.parse(res.kind === "text" ? res.text : "{}");
		expect(out.items).toEqual([
			expect.objectContaining({
				subject: "alice",
				category: "项目进展",
				content: "星火项目完成 80%",
				sources: [7],
				action: "new",
			}),
			expect.objectContaining({ subject: "carol", action: "new" }),
			expect.objectContaining({
				subject: "alice",
				action: "supersede",
				supersedes: "aaaa1111",
			}),
		]);
	});

	it("画像：每条一段，小标题按 kind", () => {
		const res = mockDecide(trigger("profile"), [
			{
				role: "user",
				content:
					"记忆条目：\n[M:aaaa1111] (preference｜工作方式偏好) 上午写文档\n[M:bbbb2222] (decision｜决定与口径) 预算不含税",
			},
		]);
		const out = JSON.parse(res.kind === "text" ? res.text : "{}");
		expect(out.sections).toEqual([
			{ heading: "协作偏好", text: "上午写文档", itemIds: ["aaaa1111"] },
			{ heading: "最近定了什么", text: "预算不含税", itemIds: ["bbbb2222"] },
		]);
	});
});
