"use client";

import { MESSAGE_MAX_LENGTH, type Principal } from "@orgos/protocol";
import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { IconClip, IconPlus, IconSend } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/badge";
import { MenuItem, Popover } from "@/components/ui/popover";
import { cx } from "@/lib/cx";
import { onBehalfLabel, type PrincipalMap } from "@/lib/principals";
import { extractMentions } from "@/lib/thread";

/** 15px × 1.6 行高 × 8 行。 */
const LINE_PX = 24;
const MAX_LINES = 8;
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

/** 补全列表：同事在前、代理在后，各自保留过滤后的顺序。 */
function grouped(list: readonly Principal[]): {
	label: string;
	items: Principal[];
}[] {
	const humans = list.filter((p) => p.kind === "human");
	const agents = list.filter((p) => p.kind === "agent");
	return [
		{ label: "同事", items: humans },
		{ label: "代理", items: agents },
	].filter((g) => g.items.length > 0);
}

/**
 * 浮起的胶囊输入框（DESIGN.md §4）：左"+"、右发送；Enter 发送、Shift+Enter 换行
 * （输入法组字中的 Enter 不发送）；多行自适应最高 8 行；`@` 弹出成员补全（人与代理分组）。
 */
export function Composer({
	members,
	meId,
	map,
	onSend,
	placeholder,
}: {
	members: readonly Principal[];
	meId: string;
	map: PrincipalMap;
	onSend: (text: string, mentions: string[]) => Promise<void>;
	placeholder: string;
}) {
	const area = useRef<HTMLTextAreaElement>(null);
	const [text, setText] = useState("");
	const [multiline, setMultiline] = useState(false);
	const [attachOpen, setAttachOpen] = useState(false);
	const [mention, setMention] = useState<MentionQuery | null>(null);
	const [highlight, setHighlight] = useState(0);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const groups = mention
		? grouped(
				members
					.filter((p) => p.id !== meId && matches(p, mention.query))
					.slice(0, SUGGESTION_LIMIT),
			)
		: [];
	const suggestions = groups.flatMap((g) => g.items);
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
		const height = Math.min(el.scrollHeight, LINE_PX * MAX_LINES);
		el.style.height = `${height}px`;
		setMultiline(height > LINE_PX * 1.5);
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
		<div className="relative mx-auto w-full max-w-thread px-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-6 md:pb-5">
			{open ? (
				<div
					role="listbox"
					aria-label="提及成员"
					className="absolute bottom-full left-3 z-30 mb-2 w-72 max-w-[calc(100%-1.5rem)] animate-pop-in overflow-hidden rounded-card bg-bg py-1 shadow-float md:left-6"
				>
					{groups.map((g) => (
						<div key={g.label}>
							<p className="px-3 pt-2 pb-1 text-12 text-muted">{g.label}</p>
							{g.items.map((p) => {
								const i = suggestions.indexOf(p);
								const owner =
									p.kind === "agent" ? onBehalfLabel(p, map, meId) : null;
								return (
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
											"flex w-full items-center gap-2.5 px-3 py-1.5 text-left",
											i === highlight && "bg-surface-2",
										)}
									>
										<Avatar principal={p} size={28} />
										<span className="min-w-0 flex-1 truncate text-14 text-ink">
											{p.displayName}
										</span>
										{owner ? (
											<Tag>{`代${owner}`}</Tag>
										) : (
											<span className="shrink-0 text-12 text-muted">
												@{p.handle}
											</span>
										)}
									</button>
								);
							})}
						</div>
					))}
				</div>
			) : null}
			{error ? (
				<p role="alert" className="mb-2 px-2 text-12 text-danger">
					发送失败：{error}
				</p>
			) : null}
			<div
				className={cx(
					"flex items-end gap-2 bg-bg p-2 shadow-float transition-[border-radius] duration-150",
					multiline ? "rounded-bubble" : "rounded-pill",
				)}
			>
				<Popover
					open={attachOpen}
					onClose={() => setAttachOpen(false)}
					panelClassName="bottom-full left-0 mb-3 w-52"
					trigger={
						<button
							type="button"
							aria-label="更多"
							title="更多"
							aria-expanded={attachOpen}
							onClick={() => setAttachOpen((v) => !v)}
							className="inline-flex size-8 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink transition-colors duration-150 hover:bg-line"
						>
							<IconPlus size={18} />
						</button>
					}
				>
					<MenuItem disabled>
						<IconClip size={18} />
						附件即将开放
					</MenuItem>
				</Popover>
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
					className="min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-15 text-ink outline-none placeholder:text-muted focus-visible:outline-none"
				/>
				{text.length >= COUNTER_FROM ? (
					<span
						className={cx(
							"self-center text-12 tabular-nums",
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
					className="inline-flex size-8 shrink-0 items-center justify-center rounded-pill bg-accent text-on-accent transition-[background-color,color,filter] duration-150 hover:brightness-110 disabled:bg-surface-2 disabled:text-muted disabled:hover:brightness-100"
				>
					<IconSend size={18} />
				</button>
			</div>
		</div>
	);
}
