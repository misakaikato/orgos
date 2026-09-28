import type { MessageFormat } from "@orgos/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	HTML_SANDBOX,
	htmlDocument,
	MessageBody,
} from "@/components/conversation/message-body";

const HANDLES: ReadonlySet<string> = new Set(["zhouye"]);

function render(text: string, format?: MessageFormat): string {
	return renderToStaticMarkup(
		createElement(MessageBody, {
			payload: format ? { text, format } : { text },
			handles: HANDLES,
		}),
	);
}

describe("text（缺省）", () => {
	it("没有 format 按纯文本：保留换行，标记符号原样显示，@提及是标签", () => {
		const out = render("**不加粗**\n@zhouye 看下");
		expect(out).toContain("whitespace-pre-wrap");
		expect(out).toContain("**不加粗**");
		expect(out).not.toContain("<strong");
		expect(out).toContain(
			'<span class="font-medium text-accent">@zhouye</span>',
		);
	});
});

describe("md", () => {
	it("内嵌的原始 HTML 不渲染", () => {
		const out = render(
			'前<script>alert(1)</script><b>粗</b><img src="https://x.test/a.png" onerror="alert(1)">后\n\n<div>块</div>',
			"md",
		);
		expect(out).not.toMatch(/<script|<b>|<img|<div>块|onerror/);
		expect(out).toContain("前");
		expect(out).toContain("后");
	});

	it("加粗、列表、表格、代码块", () => {
		const out = render(
			"**重点**\n\n- 一\n  - 二\n\n| 项目 | 日期 |\n|---|---|\n| A | 10-20 |\n\n```sql\nselect 1;\n```",
			"md",
		);
		expect(out).toContain('<strong class="font-semibold">重点</strong>');
		expect(out.match(/<ul/g)).toHaveLength(2);
		expect(out).toMatch(/<div class="[^"]*overflow-x-auto[^"]*"><table/);
		expect(out).toMatch(/<pre class="[^"]*overflow-x-auto[^"]*font-code/);
		expect(out).toContain("select 1;");
	});

	it("链接新窗口打开并带 noopener noreferrer；javascript: 链接被去掉", () => {
		const out = render(
			"[官网](https://example.com) [坏](javascript:alert(1))",
			"md",
		);
		expect(out).toContain(
			'<a href="https://example.com" target="_blank" rel="noopener noreferrer"',
		);
		expect(out).not.toContain("javascript:");
	});

	it("图片只显示为链接，不自动加载", () => {
		const out = render("![架构图](https://x.test/a.png)", "md");
		expect(out).not.toContain("<img");
		expect(out).toContain('href="https://x.test/a.png"');
		expect(out).toContain("图片：架构图");
	});

	it("@提及渲染成标签，代码与链接里的不算", () => {
		const out = render("@zhouye 看 `@zhouye` 与 [@zhouye](https://a.b)", "md");
		expect(
			out.match(/<span class="font-medium text-accent">@zhouye<\/span>/g),
		).toHaveLength(1);
	});

	it("单个波浪线不是删除线（中文里常写 10~20）", () => {
		expect(render("10~20 号", "md")).not.toContain("<del");
	});
});

describe("html", () => {
	it("放进沙箱 iframe，不含 allow-scripts", () => {
		const out = render("<p>表</p><script>alert(1)</script>", "html");
		expect(out).toContain("<iframe");
		expect(out).toContain(`sandbox="${HTML_SANDBOX}"`);
		expect(HTML_SANDBOX).not.toContain("allow-scripts");
		expect(out).not.toContain("allow-scripts");
	});

	it("文档挡住外部资源，链接默认新窗口", () => {
		const doc = htmlDocument("<p>x</p>", "");
		expect(doc).toContain("Content-Security-Policy");
		expect(doc).toContain("default-src 'none'");
		expect(doc).toContain('<base target="_blank">');
		expect(doc).toContain("<body><p>x</p></body>");
	});
});
