/**
 * 单元：消息正文的纯文本形态（`plainTextOf`，会话预览、通知、记忆材料等共用），
 * 以及给模型看的形态（`modelTextOf`：md 原样、html 转纯文本）。
 */
import {
	type Event,
	formatOf,
	type MessageFormat,
	plainTextOf,
} from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import { historyMessages, modelTextOf } from "@/agent/prompt";

const md = (text: string) => plainTextOf({ text, format: "md" });
const html = (text: string) => plainTextOf({ text, format: "html" });

describe("formatOf", () => {
	it("缺省为 text", () => {
		expect(formatOf({})).toBe("text");
		expect(formatOf({ format: "md" })).toBe("md");
	});
});

describe("text", () => {
	it("原样返回，包括看起来像标记的符号与换行", () => {
		const text = "**不是加粗**\n- 也不是列表\n<b>&amp;</b>";
		expect(plainTextOf({ text })).toBe(text);
		expect(plainTextOf({ text, format: "text" })).toBe(text);
	});
});

describe("md", () => {
	it("强调、删除线、行内代码去掉标记", () => {
		expect(md("**加粗** 与 *斜体*、__强__、_斜_ 和 ~~删除~~")).toBe(
			"加粗 与 斜体、强、斜 和 删除",
		);
		expect(md("***又粗又斜***")).toBe("又粗又斜");
		expect(md("用 `a*b*c` 计算")).toBe("用 a*b*c 计算");
		expect(md("``含 ` 的代码``")).toBe("含 ` 的代码");
	});

	it("下划线夹在字母数字之间不是强调", () => {
		expect(md("snake_case_name 和 __init__ 方法")).toBe(
			"snake_case_name 和 init 方法",
		);
	});

	it("标题、引用、分隔线", () => {
		expect(md("# 一级\n## 二级 ##\n> 引用\n> > 嵌套引用\n\n---\n\n正文")).toBe(
			"一级\n二级\n引用\n嵌套引用\n\n正文",
		);
	});

	it("嵌套列表：去掉符号与序号，保留缩进；任务列表去掉复选框", () => {
		expect(
			md(
				"- 一\n  - 一点一\n    1. 一点一点一\n2) 二\n+ [x] 已完成\n* [ ] 未完成",
			),
		).toBe("一\n  一点一\n    一点一点一\n二\n已完成\n未完成");
	});

	it("代码块：去掉围栏，内容原样保留（不剥标记、不解实体）", () => {
		expect(
			md(
				"示例：\n```sql\nselect * from t where note = '**x**' and a &amp; b;\n```\n~~~\n# 不是标题\n~~~\n结束",
			),
		).toBe(
			"示例：\nselect * from t where note = '**x**' and a &amp; b;\n# 不是标题\n结束",
		);
	});

	it("代码块里长一点的围栏才能收尾", () => {
		expect(md("````\n```\n内层\n```\n````\n后")).toBe("```\n内层\n```\n后");
	});

	it("链接留文字，没有文字留地址；图片留替代文字；自动链接与引用式链接", () => {
		expect(
			md('[官网](https://example.com "标题") 与 [](https://only.url)'),
		).toBe("官网 与 https://only.url");
		expect(md("![架构图](https://x.com/a.png) 见上")).toBe("架构图 见上");
		expect(md("<https://a.b/c> 或 <ops@example.com>")).toBe(
			"https://a.b/c 或 ops@example.com",
		);
		expect(md("看[这里][doc]\n\n[doc]: https://doc.example.com")).toBe(
			"看这里",
		);
	});

	it("表格：去掉竖线与分隔行，单元格之间两个空格，单元格里的标记也去掉", () => {
		expect(
			md(
				"| 项目 | 上线 |\n|:--|--:|\n| 结算页 | **10-20** |\n| A \\| B | `11-01` |\n\n表后",
			),
		).toBe("项目  上线\n结算页  10-20\nA | B  11-01\n\n表后");
	});

	it("没有分隔行的竖线不当表格", () => {
		expect(md("a | b")).toBe("a | b");
	});

	it("html 实体解码一次；认不出的原样保留；内嵌 HTML 标签去掉", () => {
		expect(md("AT&amp;T &lt;b&gt; &#x4E2D;&#25991; &amp;lt; &nope;")).toBe(
			"AT&T <b> 中文 &lt; &nope;",
		);
		expect(md("前<span style='x'>中</span>后<br/>")).toBe("前中后");
	});

	it("转义的标记符号保留为字面", () => {
		expect(md("\\*不是斜体\\* 与 \\# 号")).toBe("*不是斜体* 与 # 号");
	});

	it("连续空行并成一行，首尾空行去掉", () => {
		expect(md("\n\n第一段\n\n\n\n第二段\n\n")).toBe("第一段\n\n第二段");
	});
});

describe("html", () => {
	it("取文本内容：块级元素换行，脚本与样式整段去掉", () => {
		expect(
			html(
				"<style>p{color:red}</style><h2>排期</h2><p>第一段 <b>加粗</b></p><script>alert(1)</script><ul><li>一</li><li>二</li></ul>",
			),
		).toBe("排期\n第一段 加粗\n一\n二");
	});

	it("表格单元格之间两个空格；br 换行；注释去掉", () => {
		expect(
			html(
				"<table><tr><th>项目</th><th>日期</th></tr><tr><td>A</td><td>10-20</td></tr></table>甲<br>乙<!-- 注释 -->",
			),
		).toBe("项目  日期\nA  10-20\n甲\n乙");
	});

	it("源码里的空白按 HTML 规则折叠；实体解码", () => {
		expect(
			html("<p>  多个\n  空白 </p><p>x&nbsp;&amp;&nbsp;y &#8594; z</p>"),
		).toBe("多个 空白\nx & y → z");
	});
});

describe("模型输入：md 原样，html 转纯文本", () => {
	const TENANT = "44444444-4444-4444-8444-444444444444";
	const CONV = "55555555-5555-4555-8555-555555555555";
	const TOPIC = "77777777-7777-4777-8777-777777777777";
	const LIN = "11111111-1111-4111-8111-111111111111";
	const TWIN = "22222222-2222-4222-8222-222222222222";

	function posted(
		seq: number,
		actorId: string,
		text: string,
		format?: MessageFormat,
	): Event {
		return {
			id: seq,
			tenantId: TENANT,
			conversationId: CONV,
			topicId: TOPIC,
			seq,
			type: "message.posted",
			actorId,
			onBehalfOfId: actorId === TWIN ? LIN : null,
			payload: { text, mentions: [], ...(format ? { format } : {}) },
			createdAt: "2026-09-28T01:00:00.000Z",
		};
	}

	it("历史：自己的 md 回复与别人的 md 消息保留标记，html 以纯文本进入", () => {
		const reply = "| 项目 | 上线 |\n|---|---|\n| A | **10-20** |";
		const messages = historyMessages(
			[
				posted(1, LIN, "用表格对比一下"),
				posted(2, TWIN, reply, "md"),
				posted(3, LIN, "**加粗**的问题", "md"),
				posted(4, TWIN, "<p>见<b>下表</b></p><script>x()</script>", "html"),
			],
			TWIN,
			() => "林晓",
		);
		expect(messages).toEqual([
			{ role: "user", content: "【林晓】用表格对比一下" },
			{ role: "assistant", content: reply },
			{ role: "user", content: "【林晓】**加粗**的问题" },
			{ role: "assistant", content: "见下表" },
		]);
	});

	it("触发消息同一规则", () => {
		expect(modelTextOf({ text: "- **一**", format: "md" })).toBe("- **一**");
		expect(modelTextOf({ text: "**原样**" })).toBe("**原样**");
		expect(modelTextOf({ text: "<ul><li>一</li></ul>", format: "html" })).toBe(
			"一",
		);
	});
});
