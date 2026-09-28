/**
 * 消息正文的纯文本形态：会话列表预览、系统通知、记忆提炼材料、代理的历史上下文等
 * 不渲染格式的地方一律经 `plainTextOf` 取正文。md 去掉标记符号，html 取文本内容。
 *
 * 这里只做"去标记"，不追求完整的 Markdown / HTML 解析：结果给人和模型读，
 * 宁可留下个别符号，也不丢正文。
 */
import type { MessageFormat } from "./events";

type MessageBody = { text: string; format?: MessageFormat };

/** 消息的格式；旧消息没有 format 字段，按纯文本处理。 */
export function formatOf(payload: { format?: MessageFormat }): MessageFormat {
	return payload.format ?? "text";
}

export function plainTextOf(payload: MessageBody): string {
	switch (formatOf(payload)) {
		case "text":
			return payload.text;
		case "md":
			return markdownToPlain(payload.text);
		case "html":
			return htmlToPlain(payload.text);
	}
}

// ─────────────────────────── HTML 实体 ───────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ensp: " ",
	emsp: " ",
	thinsp: " ",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	middot: "·",
	bull: "•",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	times: "×",
	divide: "÷",
	deg: "°",
	yen: "¥",
	euro: "€",
	pound: "£",
	larr: "←",
	rarr: "→",
	uarr: "↑",
	darr: "↓",
};

/** 解码一遍实体（`&amp;lt;` → `&lt;`）；认不出的原样保留。 */
function decodeEntities(text: string): string {
	return text.replace(
		/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g,
		(whole, body: string) => {
			if (body.startsWith("#")) {
				const hex = body[1] === "x" || body[1] === "X";
				const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
				if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
					return "�";
				return String.fromCodePoint(code);
			}
			return NAMED_ENTITIES[body] ?? whole;
		},
	);
}

// ─────────────────────────── HTML ───────────────────────────

const BLOCK_TAGS =
	"address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|thead|tfoot|tr|ul";

function htmlToPlain(html: string): string {
	const text = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|head|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/\s+/g, " ")
		.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
		.replace(/<\/t[dh]\s*>/gi, "  ")
		.replace(/<\/?[A-Za-z][^>]*>/g, "");
	return tidyLines(decodeEntities(text).split("\n"));
}

/** 逐行去掉首尾空白，丢掉空行。 */
function tidyLines(lines: readonly string[]): string {
	return lines
		.map((l) => l.replace(/[ \t\u00a0]+$/g, "").replace(/^[ \t\u00a0]+/g, ""))
		.filter((l) => l.length > 0)
		.join("\n");
}

// ─────────────────────────── Markdown ───────────────────────────

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]+|$)(.*?)(?:[ \t]+#+)?[ \t]*$/;
const QUOTE_RE = /^ {0,3}(?:>[ \t]?)+/;
const LIST_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const TABLE_DELIMITER_RE =
	/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const LINK_DEFINITION_RE = /^ {0,3}\[[^\]]+\]:[ \t]*\S+.*$/;

function markdownToPlain(md: string): string {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let fence: string | null = null;
	let inTable = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const fenceMark = FENCE_RE.exec(line)?.[1];
		if (fence !== null) {
			if (
				fenceMark &&
				fenceMark[0] === fence[0] &&
				fenceMark.length >= fence.length &&
				line.trim() === fenceMark
			) {
				fence = null;
				continue;
			}
			out.push(line);
			continue;
		}
		if (fenceMark) {
			fence = fenceMark;
			continue;
		}
		const next = lines[i + 1] ?? "";
		if (!inTable && isTableRow(line) && isTableDelimiter(next)) {
			inTable = true;
			out.push(tableRow(line));
			i++;
			continue;
		}
		if (inTable) {
			if (isTableRow(line)) {
				out.push(tableRow(line));
				continue;
			}
			inTable = false;
		}
		if (RULE_RE.test(line) || LINK_DEFINITION_RE.test(line)) continue;
		out.push(inline(blockLine(line)));
	}
	return collapseBlankLines(out);
}

function isTableRow(line: string): boolean {
	return line.includes("|") && line.trim().length > 0;
}

function isTableDelimiter(line: string): boolean {
	return line.includes("-") && TABLE_DELIMITER_RE.test(line);
}

/** 表格一行：去掉首尾竖线，单元格之间留两个空格。 */
function tableRow(line: string): string {
	const cells = line
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "")
		.split(/(?<!\\)\|/)
		.map((c) => inline(c.trim().replace(/\\\|/g, "|")));
	return cells.join("  ").trim();
}

/** 去掉行首的块级标记：标题、引用、列表（保留缩进）。 */
function blockLine(line: string): string {
	const heading = HEADING_RE.exec(line);
	if (heading) return heading[1] ?? "";
	const unquoted = line.replace(QUOTE_RE, "");
	return unquoted.replace(LIST_RE, "$1");
}

const PH_OPEN = "\uE000";
const PH_CLOSE = "\uE001";

/** 行内标记：代码、转义先换成占位符，其余标记剥掉后再换回。 */
function inline(text: string): string {
	const kept: string[] = [];
	const keep = (s: string) => `${PH_OPEN}${kept.push(s) - 1}${PH_CLOSE}`;
	let s = text
		.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) =>
			keep(code.length > 1 && /^ .* $/.test(code) ? code.slice(1, -1) : code),
		)
		.replace(/\\([!-/:-@[-`{-~])/g, (_m, ch: string) => keep(ch))
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(
			/\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["'(][^)]*["')])?\s*\)/g,
			(_m, label: string, href: string) => label || href,
		)
		.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
		.replace(/<((?:https?|mailto|ftp):[^\s>]+)>/gi, "$1")
		.replace(/<([^\s<>@]+@[^\s<>@]+)>/g, "$1")
		.replace(/<\/?[A-Za-z][^>]*>/g, "");
	let prev: string;
	do {
		prev = s;
		s = s
			.replace(
				/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g,
				(m, mark: string, body: string, at: number, all: string) =>
					mark === "__" && !underscoreFlank(all, at, m.length) ? m : body,
			)
			.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
			.replace(
				/(\*|_)(?=\S)([\s\S]*?\S)\1/g,
				(m, mark: string, body: string, at: number, all: string) =>
					mark === "_" && !underscoreFlank(all, at, m.length) ? m : body,
			);
	} while (s !== prev);
	s = decodeEntities(s);
	return s.replace(
		new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g"),
		(_m, n: string) => kept[Number(n)] ?? "",
	);
}

/** 下划线强调两侧不能紧贴字母数字（`snake_case_name` 不是强调）。 */
function underscoreFlank(all: string, at: number, length: number): boolean {
	const before = all[at - 1] ?? "";
	const after = all[at + length] ?? "";
	return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
}

/** 连续空行并成一行，去掉首尾空行。 */
function collapseBlankLines(lines: readonly string[]): string {
	const out: string[] = [];
	for (const l of lines) {
		const line = l.replace(/[ \t]+$/, "");
		if (line === "" && (out.length === 0 || out[out.length - 1] === ""))
			continue;
		out.push(line);
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out.join("\n");
}
