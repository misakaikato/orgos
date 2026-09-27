/**
 * 记忆层的文本工具：写入前的凭据清洗、检索用的词项（中文按字二元组、英文按词）与相似度。
 */

/** 抹去后的占位：只留长度，不留任何原字符。 */
export function redactedMark(length: number): string {
	return `«已抹去 ${length} 字符»`;
}

type Rule = { re: RegExp; group?: number };

/**
 * 疑似凭据：私钥块、Bearer 令牌、JWT、常见厂商 key 前缀，以及 `password: 值` 这类键值
 * （只抹值，保留键名）。
 */
const RULES: Rule[] = [
	{
		re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
	},
	{ re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
	{ re: /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/gi, group: 1 },
	{
		re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{30,}/g,
	},
	{
		re: /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|token|密码|口令|密钥)\s*[:：=]\s*["']?([^\s"'，。；;,]+)/gi,
		group: 1,
	},
];

/** 把疑似凭据替换为 `«已抹去 N 字符»`。 */
export function scrubSecrets(text: string): string {
	let out = text;
	for (const { re, group } of RULES) {
		out = out.replace(re, (whole: string, ...rest: unknown[]) => {
			if (group === undefined) return redactedMark(Array.from(whole).length);
			const secret = rest[group - 1];
			if (typeof secret !== "string" || !secret) return whole;
			if (secret.startsWith("«已抹去")) return whole;
			return whole.replace(secret, redactedMark(Array.from(secret).length));
		});
	}
	return out;
}

const HAN = /\p{Script=Han}/u;

/**
 * 检索词项：连续的汉字按相邻二字切分（单个汉字自成一项），拉丁字母与数字按词（小写）。
 */
export function terms(text: string): string[] {
	const out: string[] = [];
	const runs = text.toLowerCase().match(/\p{Script=Han}+|[a-z0-9]+/gu) ?? [];
	for (const run of runs) {
		if (HAN.test(run)) {
			const chars = Array.from(run);
			if (chars.length === 1) out.push(run);
			for (let i = 0; i + 1 < chars.length; i++)
				out.push(`${chars[i]}${chars[i + 1]}`);
		} else out.push(run);
	}
	return out;
}

/** 词项集合（去重）。 */
export function termSet(text: string): Set<string> {
	return new Set(terms(text));
}

/** 查询词在文本里命中的比例（0–1）：查询词项里有多少出现在文本中。 */
export function coverage(query: ReadonlySet<string>, text: string): number {
	if (query.size === 0) return 0;
	const have = termSet(text);
	let hit = 0;
	for (const t of query) if (have.has(t)) hit += 1;
	return hit / query.size;
}

/** 两段文本的相似度（词项的 Jaccard）。 */
export function similarity(a: string, b: string): number {
	const x = termSet(a);
	const y = termSet(b);
	if (x.size === 0 || y.size === 0) return 0;
	let both = 0;
	for (const t of x) if (y.has(t)) both += 1;
	return both / (x.size + y.size - both);
}

/** 比较用的规范形：去空白与标点、小写。 */
export function normalize(text: string): string {
	return text.toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

export function clipChars(text: string, max: number): string {
	const chars = Array.from(text.trim());
	return chars.length > max
		? `${chars.slice(0, max).join("")}…`
		: chars.join("");
}

/** 从模型输出里取出第一个 JSON 对象（容忍代码块围栏与前后说明文字）。 */
export function parseJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}
