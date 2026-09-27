"use client";

import type { Topic } from "@orgos/protocol";
import { useState } from "react";
import { IconChevronRight, IconPlus } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { cx } from "@/lib/cx";
import { createTopic } from "@/lib/store";
import { PHASE_LABEL, phaseOf } from "@/lib/topics";

/** 任务话题名前的状态点：进行中 / 等你处理 / 已完成（颜色之外有文字提示）。 */
export function TopicDot({ topic }: { topic: Topic }) {
	const phase = phaseOf(topic);
	if (!phase) return null;
	return (
		<span
			role="img"
			aria-label={PHASE_LABEL[phase]}
			title={PHASE_LABEL[phase]}
			className={cx(
				"size-2 shrink-0 rounded-pill",
				phase === "active" && "bg-accent",
				phase === "attention" && "bg-pending",
				phase === "done" && "bg-good",
			)}
		/>
	);
}

function TopicRow({
	topic,
	active,
	unread,
	onSelect,
}: {
	topic: Topic;
	active: boolean;
	unread: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			aria-current={active ? "true" : undefined}
			onClick={onSelect}
			className={cx(
				"flex h-9 w-full min-w-0 items-center gap-2 rounded-row px-3 text-left text-13 transition-colors duration-150",
				active ? "bg-accent-soft text-ink" : "text-ink hover:bg-surface-2",
			)}
		>
			<TopicDot topic={topic} />
			<span
				className={cx(
					"min-w-0 flex-1 truncate",
					unread && !active && "font-semibold",
				)}
			>
				{topic.title}
			</span>
			{unread && !active ? (
				<span
					role="img"
					aria-label="有新消息"
					className="size-1.5 shrink-0 rounded-pill bg-accent"
				/>
			) : null}
		</button>
	);
}

/** "＋新话题"：点开原位变成输入框，Enter 建立，Esc 取消。 */
function NewTopic({
	conversationId,
	onCreated,
}: {
	conversationId: string;
	onCreated: (topic: Topic) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!editing)
		return (
			<button
				type="button"
				onClick={() => setEditing(true)}
				className="flex h-9 w-full items-center gap-2 rounded-row px-3 text-13 text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
			>
				<IconPlus size={16} />
				新话题
			</button>
		);
	const submit = async () => {
		const t = title.trim();
		if (!t || busy) return;
		setBusy(true);
		setError(null);
		try {
			const topic = await createTopic(conversationId, t);
			setTitle("");
			setEditing(false);
			onCreated(topic);
		} catch (e) {
			setError(e instanceof Error ? e.message : "没建成，请重试。");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-1 px-1">
			<Input
				autoFocus
				aria-label="新话题的名字"
				placeholder="话题名，回车建立"
				value={title}
				maxLength={60}
				disabled={busy}
				onChange={(e) => setTitle(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.nativeEvent.isComposing) {
						e.preventDefault();
						void submit();
					}
					if (e.key === "Escape") setEditing(false);
				}}
				onBlur={() => {
					if (!title.trim()) setEditing(false);
				}}
				className="h-9 text-13"
			/>
			{error ? <p className="px-2 text-12 text-danger">{error}</p> : null}
		</div>
	);
}

type BarProps = {
	conversationId: string;
	topics: readonly Topic[];
	activeId: string;
	unread: ReadonlySet<string>;
	onSelect: (topicId: string) => void;
};

/** 桌面：消息区左侧的话题窄栏。 */
export function TopicRail({
	conversationId,
	topics,
	activeId,
	unread,
	onSelect,
}: BarProps) {
	return (
		<nav
			aria-label="话题"
			className="flex w-topics shrink-0 flex-col border-r border-line bg-sidebar"
		>
			<p className="px-4 pt-3 pb-1 text-12 text-muted">话题</p>
			<div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
				{topics.map((t) => (
					<TopicRow
						key={t.id}
						topic={t}
						active={t.id === activeId}
						unread={unread.has(t.id)}
						onSelect={() => onSelect(t.id)}
					/>
				))}
			</div>
			<div className="border-t border-line px-2 py-2">
				<NewTopic
					conversationId={conversationId}
					onCreated={(t) => onSelect(t.id)}
				/>
			</div>
		</nav>
	);
}

/** 手机与窄屏：会话头部下方的话题下拉。 */
export function TopicPicker({
	conversationId,
	topics,
	activeId,
	unread,
	onSelect,
}: BarProps) {
	const [open, setOpen] = useState(false);
	const active = topics.find((t) => t.id === activeId);
	const others = topics.some((t) => t.id !== activeId && unread.has(t.id));
	return (
		<div className="shrink-0 border-b border-line bg-sidebar px-3 py-1.5">
			<Popover
				open={open}
				onClose={() => setOpen(false)}
				panelClassName="top-full left-0 mt-1 w-72 max-w-[calc(100vw-24px)] px-1"
				trigger={
					<button
						type="button"
						aria-haspopup="menu"
						aria-expanded={open}
						onClick={() => setOpen((v) => !v)}
						className="flex h-8 max-w-full items-center gap-2 rounded-pill px-3 text-13 text-ink hover:bg-surface-2"
					>
						<span className="text-muted">话题</span>
						{active ? <TopicDot topic={active} /> : null}
						<span className="min-w-0 truncate font-semibold">
							{active?.title ?? "主线"}
						</span>
						{others ? (
							<span
								role="img"
								aria-label="其他话题有新消息"
								className="size-1.5 shrink-0 rounded-pill bg-accent"
							/>
						) : null}
						<IconChevronRight
							size={14}
							className={cx(
								"shrink-0 text-muted transition-transform duration-150",
								open && "rotate-90",
							)}
						/>
					</button>
				}
			>
				<div
					role="menu"
					className="flex max-h-80 flex-col gap-0.5 overflow-y-auto py-1"
				>
					{topics.map((t) => (
						<TopicRow
							key={t.id}
							topic={t}
							active={t.id === activeId}
							unread={unread.has(t.id)}
							onSelect={() => {
								setOpen(false);
								onSelect(t.id);
							}}
						/>
					))}
				</div>
				<div className="border-t border-line py-1">
					<NewTopic
						conversationId={conversationId}
						onCreated={(t) => {
							setOpen(false);
							onSelect(t.id);
						}}
					/>
				</div>
			</Popover>
		</div>
	);
}
