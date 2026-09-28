/**
 * 单元：html 消息入库前的清理（`sanitizeHtml`）。
 */
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "@/lib/sanitize-html";

describe("去掉危险元素", () => {
	it.each([
		["<p>前</p><script>alert(1)</script><p>后</p>", "<p>前</p><p>后</p>"],
		['<p>a</p><iframe src="https://x.test"></iframe>', "<p>a</p>"],
		['<object data="x.swf"><param name="a"></object>b', "b"],
		['a<embed src="x.swf">b', "ab"],
		["a<embed src=x.swf />b", "ab"],
	])("%s", (input, expected) => {
		expect(sanitizeHtml(input)).toBe(expected);
	});

	it("大小写变体、结束标签带空白、标签名后紧跟斜杠", () => {
		expect(sanitizeHtml("<ScRiPt>x()</sCrIpT >ok")).toBe("ok");
		expect(sanitizeHtml("<SCRIPT/src=//x.test/a.js></SCRIPT>ok")).toBe("ok");
		expect(sanitizeHtml("<IFRAME SRCDOC='<b>'></IfRaMe>ok")).toBe("ok");
	});

	it("没有闭合的标签也去掉，剩下的文字不再是脚本", () => {
		expect(sanitizeHtml("<p>a</p><script>alert(1)")).toBe("<p>a</p>alert(1)");
		expect(sanitizeHtml("a</script>b<iframe")).toBe("ab");
	});

	it("拼接绕过：去掉内层后重新拼出的标签也去掉", () => {
		expect(sanitizeHtml("<scr<script>x</script>ipt>alert(1)</script>ok")).toBe(
			"ok",
		);
	});

	it("属性值里的 > 不会让清理提前结束", () => {
		expect(
			sanitizeHtml('<script title="a>b">alert(1)</script><p title="x>y">z</p>'),
		).toBe('<p title="x>y">z</p>');
	});

	it("注释去掉（包括没闭合的）", () => {
		expect(sanitizeHtml("a<!-- <script>x</script> -->b<!-- 尾")).toBe("ab");
	});
});

describe("去掉事件属性", () => {
	it.each([
		['<p onclick="alert(1)">x</p>', "<p>x</p>"],
		["<img src=a.png onerror=alert(1)>", "<img src=a.png>"],
		['<div ONMOUSEOVER="x()" class="c">x</div>', '<div class="c">x</div>'],
		["<svg onLoad='x()'></svg>", "<svg></svg>"],
		["<img/src=a.png/onerror=alert(1)>", "<img src=a.png/onerror=alert(1)>"],
		["<img/onerror=alert(1)/src=a.png>", "<img>"],
		["<a\nonclick\n=\n'x()'\nhref=\"#\">y</a>", '<a href="#">y</a>'],
		["<input autofocus onfocus=x()>", "<input autofocus>"],
		["<br onclick=x() />", "<br />"],
	])("%s", (input, expected) => {
		expect(sanitizeHtml(input)).toBe(expected);
	});

	it("属性值里的引号与 > 不影响切分", () => {
		expect(
			sanitizeHtml(
				`<a title='他说"好">' onclick="x('>')" data-x="it's" href="/a">y</a>`,
			),
		).toBe(`<a title='他说"好">' data-x="it's" href="/a">y</a>`);
		expect(sanitizeHtml(`<p title="a" onclick='b"c'>x</p>`)).toBe(
			'<p title="a">x</p>',
		);
	});

	it("名字里只是含 on 的普通属性保留", () => {
		expect(sanitizeHtml('<td colspan="2" data-on="1">x</td>')).toBe(
			'<td colspan="2" data-on="1">x</td>',
		);
	});
});

describe("去掉 javascript: 链接", () => {
	it.each([
		['<a href="javascript:alert(1)">x</a>', "<a>x</a>"],
		["<a href='JavaScript:alert(1)'>x</a>", "<a>x</a>"],
		["<a href=javascript:alert(1)>x</a>", "<a>x</a>"],
		['<a href="  javascript:alert(1)">x</a>', "<a>x</a>"],
		['<a href="java\tscript:alert(1)">x</a>', "<a>x</a>"],
		['<a href="&#106;avascript:alert(1)">x</a>', "<a>x</a>"],
		['<a href="&#x6A;avascript&#58;alert(1)">x</a>', "<a>x</a>"],
		['<a href="&#106avascript:alert(1)">x</a>', "<a>x</a>"],
		['<a href="javascript&colon;alert(1)">x</a>', "<a>x</a>"],
		['<a href="jav&Tab;ascript:alert(1)">x</a>', "<a>x</a>"],
		['<a href="vbscript:msgbox(1)">x</a>', "<a>x</a>"],
		[
			'<form action="javascript:x()"><button>b</button></form>',
			"<form><button>b</button></form>",
		],
		['<svg><a xlink:href="javascript:x()">y</a></svg>', "<svg><a>y</a></svg>"],
	])("%s", (input, expected) => {
		expect(sanitizeHtml(input)).toBe(expected);
	});

	it("普通链接与内联样式原样保留", () => {
		const html =
			'<a href="https://example.com/a?b=1&amp;c=2" target="_blank">链接</a><p style="color:#333;font-weight:600">正文</p>';
		expect(sanitizeHtml(html)).toBe(html);
	});
});

describe("正常内容不变", () => {
	it("周报式的表格与内联样式原样保留，清理结果再清理一次不变", () => {
		const html = [
			'<div style="font-family:sans-serif;max-width:640px">',
			'<h2 style="margin:0 0 8px">Q4 周报</h2>',
			'<table style="border-collapse:collapse"><tr><th>项目</th><th>进度</th></tr>',
			"<tr><td>订单服务迁移</td><td>70%</td></tr></table>",
			"<p>a &lt; b，1 < 2 且 3 > 2</p><br><hr/>",
			"</div>",
		].join("");
		expect(sanitizeHtml(html)).toBe(html.replace("<hr/>", "<hr />"));
		expect(sanitizeHtml(sanitizeHtml(html))).toBe(sanitizeHtml(html));
	});
});
