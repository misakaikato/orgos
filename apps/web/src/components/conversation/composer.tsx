"use client";

import { MESSAGE_MAX_LENGTH, type Principal } from "@orgos/protocol";
import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { IconSend } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { cx } from "@/lib/cx";
import { extractMentions } from "@/lib/thread";

const MAX_HEIGHT_PX = 200;
const SUGGESTION_LIMIT = 6;
const COUNTER_FROM = MESSAGE_MAX_LENGTH - 1000;

type MentionQuery = { start: number; query: string };

/** 光标前是否正在输入 `@xxx`（@ 前不是字母数字，以免把邮箱当成提及；中文标点后也可以 @）。 */
function mentionQueryAt(text: string, caret: number): MentionQuery | null {
	const m = /(^|[^A-Za-z0-9._%+-])@([^\s@]*)$/.exec(text.slice(0, caret));
	if (!m) return null;
	return { start: caret - (m[2]?.length ?? 0) - 1, query: m[2] ?? "" };
}

function matches(p: Principal, q: string): boolean {
	const needle = q.toLowerCase();
	return (
		p.handle.includes(needle) || p.displayName.toLowerCase().includes(needle)
	);
}

/**
 * 多行输入：Enter 发送、Shift+Enter 换行（输入法组字中的 Enter 不发送）；`@` 弹出成员补全。
 */
export function Composer({
	members,
	meId,
	onSend,
	placeholder,
}: {
	members: readonly Principal[];
	meId: string;
	onSend: (text: string, mentions: string[]) => Promise<void>;
	placeholder: string;
}) {
	const area = useRef<HTMLTextAreaElement>(null);
	const [text, setText] = useState("");
	const [mention, setMention] = useState<MentionQuery | null>(null);
	const [highlight, setHighlight] = useState(0);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const suggestions = mention
		? members
				.filter((p) => p.id !== meId && matches(p, mention.query))
				.slice(0, SUGGESTION_LIMIT)
		: [];
	const open = suggestions.length > 0;
	const tooLong = text.length > MESSAGE_MAX_LENGTH;
	const canSend = text.trim().length > 0 && !tooLong && !sending;

	// 打开会话即可输入。
	useEffect(() => {
		area.current?.focus();
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 文本变化后按内容重算高度。
	useLayoutEffect(() => {
		const el = area.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
	}, [text]);

	const syncMention = (value: string, caret: number) => {
		const next = mentionQueryAt(value, caret);
		setMention(next);
		if (next?.query !== mention?.query) setHighlight(0);
	};

	const pick = (p: Principal) => {
		const el = area.current;
		if (!el || !mention) return;
		const caret = el.selectionStart;
		const insert = `@${p.handle} `;
		const value = text.slice(0, mention.start) + insert + text.slice(caret);
		setText(value);
		setMention(null);
		const pos = mention.start + insert.length;
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(pos, pos);
		});
	};

	const send = async () => {
		if (!canSend) return;
		setSending(true);
		setError(null);
		try {
			await onSend(text, extractMentions(text, members, meId));
			setText("");
			setMention(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "发送失败");
		} finally {
			setSending(false);
			area.current?.focus();
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		if (open) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const step = e.key === "ArrowDown" ? 1 : -1;
				setHighlight(
					(h) => (h + step + suggestions.length) % suggestions.length,
				);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const chosen = suggestions[highlight];
				if (chosen) pick(chosen);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setMention(null);
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	};

	return (
		<div className="relative max-w-thread px-4 pb-4 md:px-6">
			{open ? (
				<div
					role="listbox"
					aria-label="提及成员"
					className="absolute bottom-full left-4 mb-2 w-72 max-w-[calc(100%-2rem)] overflow-hidden rounded-box border border-pop-border bg-surface py-1 shadow-popover md:left-6"
				>
					{suggestions.map((p, i) => (
						<button
							key={p.id}
							type="button"
							role="option"
							tabIndex={-1}
							aria-selected={i === highlight}
							onMouseDown={(e) => {
								e.preventDefault();
								pick(p);
							}}
							onMouseEnter={() => setHighlight(i)}
							className={cx(
								"flex w-full items-center gap-3 px-3 py-2 text-left",
								i === highlight && "bg-surface-2",
							)}
						>
							<Avatar principal={p} size="sm" />
							<span className="min-w-0 flex-1 truncate text-14 text-ink">
								{p.displayName}
							</span>
							<span className="shrink-0 font-code text-12 text-muted">
								@{p.handle}
							</span>
						</button>
					))}
				</div>
			) : null}
			{error ? (
				<p role="alert" className="mb-2 text-12 text-danger">
					发送失败：{error}
				</p>
			) : null}
			<div className="flex items-end gap-2 rounded-box bg-surface-2 py-2 pr-2 pl-4 focus-within:ring-2 focus-within:ring-accent">
				<textarea
					ref={area}
					rows={1}
					value={text}
					placeholder={placeholder}
					aria-label="消息"
					onChange={(e) => {
						setText(e.target.value);
						syncMention(e.target.value, e.target.selectionStart);
					}}
					onSelect={(e) =>
						syncMention(e.currentTarget.value, e.currentTarget.selectionStart)
					}
					onBlur={() => setMention(null)}
					onKeyDown={onKeyDown}
					className="max-h-[200px] min-h-8 flex-1 resize-none bg-transparent py-1 text-15 text-ink outline-none placeholder:text-muted focus-visible:outline-none"
				/>
				{text.length >= COUNTER_FROM ? (
					<span
						className={cx(
							"self-center font-code text-12 tabular-nums",
							tooLong ? "text-danger" : "text-muted",
						)}
					>
						{text.length}/{MESSAGE_MAX_LENGTH}
					</span>
				) : null}
				<button
					type="button"
					aria-label="发送"
					title="发送（Enter）"
					disabled={!canSend}
					onClick={() => void send()}
					className="inline-flex size-8 shrink-0 items-center justify-center rounded-capsule bg-accent text-surface transition-[box-shadow,opacity] duration-150 hover:ring-4 hover:ring-accent-soft disabled:opacity-40 disabled:hover:ring-0"
				>
					<IconSend size={18} />
				</button>
			</div>
			<p className="mt-2 hidden font-code text-12 text-muted md:block">
				Enter 发送 · Shift+Enter 换行 · @ 提及成员
			</p>
		</div>
	);
}
