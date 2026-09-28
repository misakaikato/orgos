/**
 * html 消息入库前的清理：去掉 `<script>`、`<iframe>`、`<object>`、`<embed>`（连同前三者的内容）、
 * 注释、`on*` 事件属性，以及值为 `javascript:` / `vbscript:` 地址的属性。
 *
 * 真正的防线是渲染时不给 allow-scripts 的沙箱；这里只让存进库里的内容也干净，
 * 所以宁可多删：任何属性的值只要解码后以这两种协议开头就整个去掉，不区分属性名。
 */

const PAIRED =
	/<(script|iframe|object)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/\1\s*>/gi;
const STRAY =
	/<\/?(?:script|iframe|object|embed)\b(?:"[^"]*"|'[^']*'|[^'">])*>?/gi;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
/** 开始标签：名字之后的属性区按引号跳过，值里的 `>` 不会提前结束标签。 */
const START_TAG = /<([A-Za-z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const SCRIPT_URL = /^(?:javascript|vbscript):/i;

export function sanitizeHtml(html: string): string {
	let out = html;
	for (let prev = ""; out !== prev; ) {
		prev = out;
		out = untilStable(out, (s) => s.replace(COMMENT, "").replace(PAIRED, ""))
			.replace(STRAY, "")
			.replace(START_TAG, (_m, name: string, attrs: string) => {
				const kept = parseAttributes(attrs).filter(isSafeAttribute);
				const selfClosing = /\/\s*$/.test(attrs);
				const body = kept.map((a) => ` ${a.raw}`).join("");
				return `<${name}${body}${selfClosing ? " /" : ""}>`;
			});
	}
	return out;
}

/** 去掉一层后可能拼出新的一层（`<scr<script></script>ipt>`），反复做到不再变化。 */
function untilStable(text: string, step: (s: string) => string): string {
	let out = text;
	for (let prev = ""; out !== prev; ) {
		prev = out;
		out = step(out);
	}
	return out;
}

type Attribute = { name: string; value: string; raw: string };

/** 按 HTML 的属性语法切分：空白与 `/` 分隔；值可以是双引号、单引号或不带引号。 */
function parseAttributes(source: string): Attribute[] {
	const attrs: Attribute[] = [];
	const re =
		/[\s/]*([^\s/>"'=][^\s/>=]*|=[^\s/>=]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;
	for (let m = re.exec(source); m !== null; m = re.exec(source)) {
		if (m[0].length === 0) {
			re.lastIndex++;
			continue;
		}
		const name = m[1] ?? "";
		const rawValue = m[2];
		const value =
			rawValue === undefined
				? ""
				: /^["']/.test(rawValue)
					? rawValue.slice(1, -1)
					: rawValue;
		const raw = rawValue === undefined ? name : `${name}=${rawValue}`;
		attrs.push({ name, value, raw });
	}
	return attrs;
}

function isSafeAttribute(attr: Attribute): boolean {
	if (/^on/i.test(attr.name)) return false;
	return !SCRIPT_URL.test(urlSchemeView(attr.value));
}

/**
 * 浏览器解析地址前会解码实体、忽略所有 ASCII 空白与控制字符；这里照做一遍再看协议。
 * 数字实体可以不带分号（`&#106avascript:`）。
 */
function urlSchemeView(value: string): string {
	const decoded = value
		.replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) =>
			codePoint(Number.parseInt(hex, 16)),
		)
		.replace(/&#([0-9]+);?/g, (_m, dec: string) =>
			codePoint(Number.parseInt(dec, 10)),
		)
		.replace(/&colon;/gi, ":")
		.replace(/&(?:tab|newline);/gi, "");
	return Array.from(decoded).filter(isVisibleInUrl).join("");
}

/** 空格、C0 与 C1 控制字符在地址里被忽略。 */
function isVisibleInUrl(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0;
	return code > 0x20 && !(code >= 0x7f && code <= 0x9f);
}

function codePoint(code: number): string {
	return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
		? String.fromCodePoint(code)
		: "";
}
