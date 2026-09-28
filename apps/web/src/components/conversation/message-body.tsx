"use client";

import { formatOf, type MessageFormat } from "@orgos/protocol";
import { useEffect, useRef, useState } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "@/lib/cx";
import { splitMentions } from "@/lib/thread";

/**
 * 消息正文（spec「消息格式」）：
 * - text：保留换行，@提及渲染成标签；
 * - md：react-markdown + remark-gfm，不渲染内嵌 HTML，链接新窗口打开，图片只显示为链接，
 *   代码块与表格在气泡内横向滚动；
 * - html：无脚本的沙箱 iframe，高度随内容，上限 600px。
 */
export function MessageBody({
	payload,
	handles,
}: {
	payload: { text: string; format?: MessageFormat };
	handles: ReadonlySet<string>;
}) {
	switch (formatOf(payload)) {
		case "text":
			return <PlainText text={payload.text} handles={handles} />;
		case "md":
			return <MarkdownText text={payload.text} handles={handles} />;
		case "html":
			return <HtmlFrame html={payload.text} />;
	}
}

/** 被 @ 的成员名的样式（纯文本与 Markdown 共用）。 */
const MENTION_CLASS = "font-medium text-accent";

export function PlainText({
	text,
	handles,
}: {
	text: string;
	handles: ReadonlySet<string>;
}) {
	return (
		<p className="text-15 whitespace-pre-wrap break-words text-ink [overflow-wrap:anywhere]">
			{splitMentions(text, handles).map((part, i) =>
				part.mention ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: 片段顺序固定，只随文本整体变化。
					<span key={i} className={MENTION_CLASS}>
						{part.text}
					</span>
				) : (
					part.text
				),
			)}
		</p>
	);
}

// ─────────────────────────── Markdown ───────────────────────────

/** hast 里用到的最小结构（不为此引入类型依赖）。 */
type HastText = { type: "text"; value: string };
type HastElement = {
	type: "element";
	tagName: string;
	properties: Record<string, unknown>;
	children: HastNode[];
};
type HastNode =
	| HastText
	| HastElement
	| { type: string; children?: HastNode[] };

/** 这些元素里的文字不识别 @提及。 */
const NO_MENTION_TAGS = new Set(["a", "code", "pre"]);

function mentionNodes(text: string, handles: ReadonlySet<string>): HastNode[] {
	return splitMentions(text, handles).map((part) =>
		part.mention
			? {
					type: "element",
					tagName: "span",
					properties: { className: MENTION_CLASS.split(" ") },
					children: [{ type: "text", value: part.text }],
				}
			: { type: "text", value: part.text },
	);
}

function markMentions(node: HastNode, handles: ReadonlySet<string>): void {
	if (!("children" in node) || !node.children) return;
	if (
		node.type === "element" &&
		NO_MENTION_TAGS.has((node as HastElement).tagName)
	)
		return;
	node.children = node.children.flatMap((child) => {
		if (child.type === "text")
			return mentionNodes((child as HastText).value, handles);
		markMentions(child, handles);
		return [child];
	});
}

/** rehype 插件：把正文里会话成员的 @handle 换成提及标签。 */
function rehypeMentions(handles: ReadonlySet<string>) {
	return () => (tree: object) => {
		if (handles.size > 0) markMentions(tree as HastNode, handles);
	};
}

type Props<K extends keyof React.JSX.IntrinsicElements> =
	React.JSX.IntrinsicElements[K] & ExtraProps;

const COMPONENTS: Components = {
	h1: ({ node: _, ...p }: Props<"h1">) => (
		<h1 {...p} className="text-16 font-semibold" />
	),
	h2: ({ node: _, ...p }: Props<"h2">) => (
		<h2 {...p} className="text-16 font-semibold" />
	),
	h3: ({ node: _, ...p }: Props<"h3">) => (
		<h3 {...p} className="text-15 font-semibold" />
	),
	h4: ({ node: _, ...p }: Props<"h4">) => (
		<h4 {...p} className="text-15 font-semibold" />
	),
	h5: ({ node: _, ...p }: Props<"h5">) => (
		<h5 {...p} className="text-15 font-semibold" />
	),
	h6: ({ node: _, ...p }: Props<"h6">) => (
		<h6 {...p} className="text-15 font-semibold" />
	),
	strong: ({ node: _, ...p }: Props<"strong">) => (
		<strong {...p} className="font-semibold" />
	),
	ul: ({ node: _, className, ...p }: Props<"ul">) => (
		<ul
			{...p}
			className={
				className?.includes("contains-task-list")
					? "space-y-1"
					: "list-disc space-y-1 pl-5"
			}
		/>
	),
	ol: ({ node: _, className: __, ...p }: Props<"ol">) => (
		<ol {...p} className="list-decimal space-y-1 pl-5" />
	),
	li: ({ node: _, className: __, ...p }: Props<"li">) => (
		<li {...p} className="[&>ol]:mt-1 [&>ul]:mt-1" />
	),
	input: ({ node: _, ...p }: Props<"input">) => (
		<input {...p} className="mr-2 align-middle" />
	),
	blockquote: ({ node: _, ...p }: Props<"blockquote">) => (
		<blockquote
			{...p}
			className="border-l-2 border-line pl-3 text-muted [&>*+*]:mt-2"
		/>
	),
	hr: ({ node: _, ...p }: Props<"hr">) => <hr {...p} className="border-line" />,
	a: ({ node: _, ...p }: Props<"a">) => (
		<a
			{...p}
			target="_blank"
			rel="noopener noreferrer"
			className="text-accent underline-offset-2 hover:underline"
		/>
	),
	img: ({ src, alt }: Props<"img">) => {
		const label = alt ? `图片：${alt}` : "图片";
		return typeof src === "string" && src ? (
			<a
				href={src}
				target="_blank"
				rel="noopener noreferrer"
				className="text-accent underline-offset-2 hover:underline"
			>
				{label}
			</a>
		) : (
			<span className="text-muted">{label}</span>
		);
	},
	code: ({ node: _, className: __, ...p }: Props<"code">) => (
		<code {...p} className="rounded-row bg-surface-2 px-1 font-code text-13" />
	),
	pre: ({ node: _, ...p }: Props<"pre">) => (
		<pre
			{...p}
			className="max-w-full overflow-x-auto rounded-row bg-surface-2 px-3 py-2 font-code text-13 whitespace-pre [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0"
		/>
	),
	table: ({ node: _, ...p }: Props<"table">) => (
		<div className="max-w-full overflow-x-auto">
			<table
				{...p}
				className="border-collapse text-14 [overflow-wrap:normal]"
			/>
		</div>
	),
	th: ({ node: _, style, ...p }: Props<"th">) => (
		<th
			{...p}
			style={style}
			className="border border-line bg-surface-2 px-2 py-1 text-left font-semibold whitespace-nowrap"
		/>
	),
	td: ({ node: _, style, ...p }: Props<"td">) => (
		<td
			{...p}
			style={style}
			className="min-w-24 border border-line px-2 py-1 align-top"
		/>
	),
};

export function MarkdownText({
	text,
	handles,
	className,
}: {
	text: string;
	handles: ReadonlySet<string>;
	className?: string;
}) {
	return (
		<div
			className={cx(
				"min-w-0 text-15 break-words text-ink [overflow-wrap:anywhere] [&>*+*]:mt-2",
				className,
			)}
		>
			<Markdown
				skipHtml
				remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
				rehypePlugins={[rehypeMentions(handles)]}
				components={COMPONENTS}
			>
				{text}
			</Markdown>
		</div>
	);
}

// ─────────────────────────── HTML ───────────────────────────

/** 不给 allow-scripts：片段里的任何脚本都不执行；同源只为让父页面量高度、跟随主题。 */
export const HTML_SANDBOX =
	"allow-same-origin allow-popups allow-popups-to-escape-sandbox";
export const HTML_MAX_HEIGHT = 600;

/** 注入 iframe 的主题变量：取父页面当前的 token 值。 */
const THEME_VARS = [
	"--bg",
	"--surface-2",
	"--line",
	"--ink",
	"--muted",
	"--accent",
	"--font-ui",
	"--font-code",
	"--fs-13",
	"--fs-15",
	"--radius-row",
] as const;

function themeCss(): string {
	if (typeof document === "undefined") return "";
	const root = getComputedStyle(document.documentElement);
	const vars = THEME_VARS.map(
		(v) => `${v}:${root.getPropertyValue(v).trim()};`,
	).join("");
	return `:root{${vars}color-scheme:${root.colorScheme || "light"};}`;
}

const BASE_CSS = [
	"html,body{margin:0;padding:0;background:transparent}",
	"body{font-family:var(--font-ui);font-size:var(--fs-15);line-height:1.6;color:var(--ink);overflow-wrap:anywhere}",
	"body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}",
	"a{color:var(--accent)}",
	"img,video{max-width:100%;height:auto}",
	"table{border-collapse:collapse}",
	"th,td{border:1px solid var(--line);padding:4px 8px;text-align:left}",
	"th{background:var(--surface-2)}",
	"pre,code{font-family:var(--font-code);font-size:var(--fs-13)}",
	"pre{overflow-x:auto;background:var(--surface-2);padding:8px 12px;border-radius:var(--radius-row)}",
	"hr{border:0;border-top:1px solid var(--line)}",
].join("");

/**
 * 片段装进完整文档：主题变量 + 基础样式；CSP 挡住一切外部资源（不自动加载外部图片、字体、表单提交）；
 * `<base target="_blank">` 让链接在新窗口打开。
 */
export function htmlDocument(html: string, theme: string): string {
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\">",
		'<base target="_blank">',
		`<style>${theme}${BASE_CSS}</style>`,
		`</head><body>${html}</body></html>`,
	].join("");
}

/** 主题（data-theme 或系统深浅色）变化时重新取变量。 */
function useThemeCss(): string {
	const [css, setCss] = useState(themeCss);
	useEffect(() => {
		const update = () => setCss(themeCss());
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		media.addEventListener("change", update);
		const observer = new MutationObserver(update);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		return () => {
			media.removeEventListener("change", update);
			observer.disconnect();
		};
	}, []);
	return css;
}

export function HtmlFrame({ html }: { html: string }) {
	const frame = useRef<HTMLIFrameElement>(null);
	const theme = useThemeCss();
	const [height, setHeight] = useState<number | null>(null);

	const measure = () => {
		const body = frame.current?.contentDocument?.body;
		if (!body) return;
		const content = Math.ceil(
			Math.max(body.scrollHeight, body.getBoundingClientRect().height),
		);
		setHeight(Math.min(content, HTML_MAX_HEIGHT));
	};

	const onLoad = () => {
		const doc = frame.current?.contentDocument;
		if (!doc) return;
		for (const a of doc.querySelectorAll("a[href]")) {
			a.setAttribute("target", "_blank");
			a.setAttribute("rel", "noopener noreferrer");
		}
		measure();
	};

	// 气泡变宽变窄时正文重新折行，高度跟着量。
	// biome-ignore lint/correctness/useExhaustiveDependencies: measure 只读 ref，每次取最新即可。
	useEffect(() => {
		const el = frame.current;
		if (!el) return;
		const observer = new ResizeObserver(() => measure());
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return (
		<iframe
			ref={frame}
			title="HTML 消息"
			sandbox={HTML_SANDBOX}
			srcDoc={htmlDocument(html, theme)}
			onLoad={onLoad}
			style={height === null ? undefined : { height }}
			className="block h-6 w-full border-0 bg-transparent"
		/>
	);
}
