/**
 * 提炼的输入与输出：把一段话题事件写成带编号的材料，交给模型；模型的 JSON 输出逐条校验。
 *
 * 校验（`validateExtraction`，纯函数）：kind、category 须在白名单；subject 须是这段交流里的真人；
 * sources 须全部是本批材料里真实存在的事件编号，有一个不是就整条丢弃；取代的对象须是给出的候选、
 * 同一 subject 与类别、且不是本人更正过的条目，否则按新增处理；action=skip 的丢弃。
 */
import {
	isMemoryCategory,
	MEMORY_CATEGORIES,
	MEMORY_ENTITY_TYPES,
	MEMORY_KINDS,
	type MemoryEntity,
	type MemoryKind,
	type MemorySource,
} from "@orgos/protocol";
import type { PrincipalRow } from "@/db/scope";
import type { MemoryItemRow } from "@/memory/access";
import type { ItemDraft } from "@/memory/store";

/** 材料里的一行：事件编号、发生时间与写给模型看的文本。 */
export type MaterialLine = {
	eventId: number;
	conversationId: string;
	topicId: string;
	at: Date;
	text: string;
};

const stamp = (d: Date) =>
	new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(d);

/** `[E123｜9/25 14:05] 发言人：内容`（时间为北京时间）。 */
export function materialText(lines: readonly MaterialLine[]): string {
	return lines
		.map((l) => `[E${l.eventId}｜${stamp(l.at)}] ${l.text}`)
		.join("\n");
}

export function candidateText(
	candidates: readonly MemoryItemRow[],
	handleOf: (id: string) => string,
): string {
	return candidates
		.map(
			(c) =>
				`[M:${c.id.slice(0, 8)}] @${handleOf(c.subjectId)}｜${c.category}｜${c.content}`,
		)
		.join("\n");
}

export const EXTRACTION_SYSTEM_PROMPT = [
	"你在为一个办公系统沉淀工作记忆：从一段对话材料里提炼以后值得记住的事，写成独立的陈述句。",
	"要求：",
	"1. 每条只写一件事，用第三人称陈述句，写清是谁、什么事、什么时间（相对时间换成绝对日期）；不要引用原话，不要写“某某说”“某某提到”。",
	"2. 只提炼有长期价值的：项目进展、排期、技术方案、决定、客户进展、流程、协作偏好、分工等；寒暄、临时安排、代理复述资料的内容不要。",
	"3. subject 是这件事关于谁，只能是材料里出现的真人的 handle（不带 @）。",
	`4. category 只能从这些里选：${MEMORY_CATEGORIES.join("、")}。涉及个人生活、薪酬、健康、家庭、对人的评价、密码与密钥的，按实归入对应类别，不要改头换面归到工作类别。`,
	`5. kind 只能是：${MEMORY_KINDS.join("、")}（事实、决定、承诺、进展、偏好、关系）。`,
	"6. sources 写依据的材料编号（[E123｜…] 写 123），只能用材料里出现过的编号；材料里的时间是消息发出的时间，据此换算日期。",
	"7. 不要把密码、密钥、令牌写进内容。",
	"8. “已有记忆”里若有同一件事：内容没变就 action=skip；有了新情况（进度变了、日期改了）就 action=supersede 并在 supersedes 写它的编号（[M:ab12cd34] 写 ab12cd34）；否则 action=new。",
	`9. entities 列出涉及的人、项目、客户、主题：type 只能是 ${MEMORY_ENTITY_TYPES.join("、")}。`,
	"只输出一个 JSON 对象，不要其他文字：",
	'{"items":[{"subject":"handle","kind":"progress","category":"项目进展","content":"……","entities":[{"type":"project","name":"……"}],"sources":[123],"confidence":0.8,"action":"new","supersedes":null}]}',
	'没有值得记的就输出 {"items":[]}。',
].join("\n");

export function extractionUserPrompt(input: {
	today: string;
	where: string;
	participants: readonly PrincipalRow[];
	material: string;
	candidates: string;
}): string {
	return [
		`今天是 ${input.today}。`,
		`材料来自${input.where}。`,
		`参与的真人：${input.participants.map((p) => `@${p.handle}（${p.displayName}）`).join("、")}`,
		"",
		"已有记忆：",
		input.candidates || "（无）",
		"",
		"对话材料：",
		input.material,
	].join("\n");
}

export type ValidDraft = Omit<ItemDraft, "scope" | "createdByRunId">;

export type ExtractionContext = {
	/** 本批材料里的事件：编号 → 所在会话与话题。 */
	events: ReadonlyMap<number, { conversationId: string; topicId: string }>;
	/** 这段交流里的真人，按 handle。 */
	humans: ReadonlyMap<string, PrincipalRow>;
	/** 候选的已有条目，按 8 位短编号。 */
	candidates: ReadonlyMap<string, MemoryItemRow>;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function entitiesOf(
	raw: unknown,
	humans: ExtractionContext["humans"],
): MemoryEntity[] {
	if (!Array.isArray(raw)) return [];
	const out: MemoryEntity[] = [];
	for (const e of raw.slice(0, 8)) {
		if (!e || typeof e !== "object") continue;
		const type = str((e as { type?: unknown }).type);
		const name = str((e as { name?: unknown }).name).slice(0, 60);
		if (!name || !(MEMORY_ENTITY_TYPES as readonly string[]).includes(type))
			continue;
		const person =
			type === "person"
				? [...humans.values()].find(
						(h) => h.displayName === name || h.handle === name,
					)
				: undefined;
		out.push({
			type: type as MemoryEntity["type"],
			name,
			...(person ? { principalId: person.id } : {}),
		});
	}
	return out;
}

function sourcesOf(
	raw: unknown,
	events: ExtractionContext["events"],
): MemorySource[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const out: MemorySource[] = [];
	for (const v of raw) {
		const id = typeof v === "string" ? Number(/\d+/.exec(v)?.[0]) : v;
		if (typeof id !== "number" || !Number.isInteger(id)) return null;
		const where = events.get(id);
		if (!where) return null;
		if (!out.some((s) => s.id === String(id)))
			out.push({ kind: "event", id: String(id), ...where });
	}
	return out;
}

/** 校验模型输出，返回可写入的条目（丢弃的不报错）。 */
export function validateExtraction(
	raw: unknown,
	ctx: ExtractionContext,
): ValidDraft[] {
	const items =
		raw && typeof raw === "object"
			? (raw as { items?: unknown }).items
			: undefined;
	if (!Array.isArray(items)) return [];
	const out: ValidDraft[] = [];
	for (const it of items) {
		if (!it || typeof it !== "object") continue;
		const o = it as Record<string, unknown>;
		if (str(o.action) === "skip") continue;
		const kind = str(o.kind);
		const category = str(o.category);
		const content = str(o.content);
		const subject = ctx.humans.get(str(o.subject).replace(/^@/, ""));
		if (!(MEMORY_KINDS as readonly string[]).includes(kind)) continue;
		if (!isMemoryCategory(category) || !content || !subject) continue;
		const sources = sourcesOf(o.sources, ctx.events);
		if (!sources) continue;
		const target =
			str(o.action) === "supersede"
				? ctx.candidates.get(/[0-9a-f]{8}/.exec(str(o.supersedes))?.[0] ?? "")
				: undefined;
		const supersedes =
			target &&
			target.subjectId === subject.id &&
			target.category === category &&
			!target.ownerCorrected
				? [target.id]
				: [];
		const confidence =
			typeof o.confidence === "number" && Number.isFinite(o.confidence)
				? o.confidence
				: 0.7;
		out.push({
			subjectId: subject.id,
			kind: kind as MemoryKind,
			category,
			content,
			entities: entitiesOf(o.entities, ctx.humans),
			sources,
			confidence,
			supersedes,
		});
	}
	return out;
}
