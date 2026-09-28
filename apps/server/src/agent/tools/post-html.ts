/**
 * post_html：这次的回复是一条 html 消息，由运行循环发在本次运行所在的话题里（见 `ToolOutcome.replied`）。
 * 正文入库前经 `sanitizeHtml` 清理（在 `postAs` 里）；摘要用于列表预览与通知。
 */
import { z } from "zod";
import { makeTool } from "@/agent/tools/tool";

export const HTML_MAX_BYTES = 50 * 1024;
export const HTML_SUMMARY_MAX_CHARS = 60;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

export const postHtmlTool = makeTool({
	name: "post_html",
	description: `发一条排版好的 HTML 消息作为这次的回复（例如能直接贴进邮件的周报、排版好的报告或卡片），发在当前对话里。html 是片段，只用内联样式（style 属性），不引用外部资源（图片、字体、样式表），不写脚本，不超过 50KB；summary 是一句话摘要（不超过 ${HTML_SUMMARY_MAX_CHARS} 字），用于会话列表预览与通知。调用后这次回复就完成了，不要再输出文字。`,
	label: "正在排版…",
	schema: z.object({
		html: z
			.string()
			.trim()
			.min(1)
			.refine(
				(html) => utf8Bytes(html) <= HTML_MAX_BYTES,
				`html 超过 ${HTML_MAX_BYTES / 1024}KB 上限`,
			),
		summary: z
			.string()
			.trim()
			.min(1)
			.refine(
				(summary) => Array.from(summary).length <= HTML_SUMMARY_MAX_CHARS,
				`summary 不能超过 ${HTML_SUMMARY_MAX_CHARS} 字`,
			),
	}),
	available: (scope) => scope.conversation.kind !== "negotiation",
	run: async ({ html, summary }) => ({
		result: "已发出",
		summary: `发了一条排版消息：${summary}`,
		ok: true,
		replied: { html, summary },
	}),
});
