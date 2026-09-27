"use client";

import {
	type Event,
	GROUP_TITLE_MAX_LENGTH,
	isTaskEnded,
	type Topic,
	type TopicSourceResponse,
} from "@orgos/protocol";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { MessageList } from "@/components/conversation/message-list";
import { TopicDot } from "@/components/conversation/topic-bar";
import { IconChevronRight } from "@/components/icons";
import { MemberPicker } from "@/components/member-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, TextAreaField } from "@/components/ui/input";
import { api } from "@/lib/api";
import { appHref } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";
import type { PrincipalMap } from "@/lib/principals";
import { topicToGroup, topicToTask, useStore } from "@/lib/store";
import { PHASE_LABEL, phaseOf } from "@/lib/topics";

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : "操作失败，请重试。";
}

/** "转为任务"：目标可以不填（取这个话题里你最后一句话）；填了就作为你的消息发出，代理随即开始。 */
function ToTaskDialog({
	conversationId,
	topic,
	onClose,
}: {
	conversationId: string;
	topic: Topic;
	onClose: () => void;
}) {
	const [goal, setGoal] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			await topicToTask(conversationId, topic.id, goal.trim() || undefined);
			onClose();
		} catch (e) {
			setError(errorText(e));
			setBusy(false);
		}
	};
	return (
		<Dialog
			title="转为任务"
			onClose={onClose}
			footer={
				<>
					{error ? (
						<p role="alert" className="mr-auto text-12 text-danger">
							{error}
						</p>
					) : null}
					<Button onClick={onClose}>取消</Button>
					<Button
						variant="primary"
						disabled={busy}
						onClick={() => void submit()}
					>
						{busy ? "正在转…" : "转为任务"}
					</Button>
				</>
			}
		>
			<p className="text-14 text-ink">
				“{topic.title}
				”会变成一个带状态的任务：话题顶部显示进度，完成后仍可以接着聊。
			</p>
			<TextAreaField
				className="mt-4"
				label="任务目标（可不填）"
				hint="不填就用这个话题里你最后一句话；填了会作为你的消息发出，代理随即开始干活。"
				value={goal}
				maxLength={8000}
				onChange={(e) => setGoal(e.target.value)}
			/>
		</Dialog>
	);
}

/** "转成群聊"：以这个话题为起点建新群，新群能展开这个话题的历史（不复制消息）。 */
function ToGroupDialog({
	conversationId,
	topic,
	onClose,
}: {
	conversationId: string;
	topic: Topic;
	onClose: () => void;
}) {
	const router = useRouter();
	const me = useStore((s) => s.me);
	const directory = useStore((s) => s.directory);
	const [title, setTitle] = useState(topic.isMain ? "" : topic.title);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!me) return null;
	const toggle = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const submit = async () => {
		if (selected.size === 0) {
			setError("至少拉一位同事或助手");
			return;
		}
		if (!title.trim()) {
			setError("给群起个名字");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const id = await topicToGroup(conversationId, topic.id, {
				title: title.trim(),
				memberIds: [...selected],
			});
			router.push(appHref(`/c/${id}`));
		} catch (e) {
			setError(errorText(e));
			setBusy(false);
		}
	};
	return (
		<Dialog
			title="转成群聊"
			onClose={onClose}
			footer={
				<>
					{error ? (
						<p role="alert" className="mr-auto text-12 text-danger">
							{error}
						</p>
					) : (
						<span className="mr-auto text-13 tabular-nums text-muted">
							已选 {selected.size}
						</span>
					)}
					<Button onClick={onClose}>取消</Button>
					<Button
						variant="primary"
						disabled={busy}
						onClick={() => void submit()}
					>
						{busy ? "正在建群…" : "建群"}
					</Button>
				</>
			}
		>
			<p className="text-14 text-ink">
				新群里能展开这个话题的历史；这个话题会标记为已转出。
			</p>
			<Field
				className="mt-4"
				label="群名"
				placeholder="例如：方案讨论"
				maxLength={GROUP_TITLE_MAX_LENGTH}
				value={title}
				onChange={(e) => setTitle(e.target.value)}
			/>
			<MemberPicker
				me={me}
				directory={directory}
				selected={selected}
				onToggle={toggle}
			/>
		</Dialog>
	);
}

/**
 * 话题标题栏：话题名（任务话题带状态点）+ "转为任务""转成群聊"。
 * 已转成群聊的话题下方一行说明，点过去即新群。
 */
export function TopicHeader({
	conversationId,
	topic,
	canTask,
}: {
	conversationId: string;
	topic: Topic;
	/** 本人与自己代理的私聊（只有这里能转为任务）。 */
	canTask: boolean;
}) {
	const [dialog, setDialog] = useState<"task" | "group" | null>(null);
	const phase = phaseOf(topic);
	const taskOpen =
		topic.kind === "task" && topic.taskState && !isTaskEnded(topic.taskState);
	const showToTask = canTask && !topic.isMain && !taskOpen;
	return (
		<div className="shrink-0 border-b border-line bg-bg">
			<div className="flex h-11 items-center gap-2 px-4 md:px-5">
				<TopicDot topic={topic} />
				<h2 className="min-w-0 flex-1 truncate text-14 font-semibold text-ink">
					{topic.title}
					{phase ? (
						<span className="ml-2 text-12 font-normal text-muted">
							{PHASE_LABEL[phase]}
						</span>
					) : null}
				</h2>
				{showToTask ? (
					<Button onClick={() => setDialog("task")}>
						{topic.kind === "task" ? "再次交办" : "转为任务"}
					</Button>
				) : null}
				<Button onClick={() => setDialog("group")}>转成群聊</Button>
			</div>
			{topic.movedToConversationId ? (
				<Link
					href={appHref(`/c/${topic.movedToConversationId}`)}
					className="flex items-center gap-1 px-4 pb-2 text-12 text-muted hover:text-accent md:px-5"
				>
					这个话题已转成群聊，去群里接着聊
					<IconChevronRight size={14} />
				</Link>
			) : null}
			{dialog === "task" ? (
				<ToTaskDialog
					conversationId={conversationId}
					topic={topic}
					onClose={() => setDialog(null)}
				/>
			) : null}
			{dialog === "group" ? (
				<ToGroupDialog
					conversationId={conversationId}
					topic={topic}
					onClose={() => setDialog(null)}
				/>
			) : null}
		</div>
	);
}

/**
 * 新群主线引用的原话题：一条折叠条"来自 X 的话题"，点开按时间展示原话题的消息（只读）。
 */
export function TopicSource({
	topicId,
	map,
	meId,
}: {
	topicId: string;
	map: PrincipalMap;
	meId: string;
}) {
	const [open, setOpen] = useState(false);
	const [data, setData] = useState<TopicSourceResponse | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let alive = true;
		api
			.topicSource(topicId)
			.then((d) => {
				if (alive) setData(d);
			})
			.catch(() => {
				if (alive) setFailed(true);
			});
		return () => {
			alive = false;
		};
	}, [topicId]);
	const sourceMap = useMemo(() => {
		if (!data) return map;
		const merged = new Map(map);
		for (const m of data.members) if (!merged.has(m.id)) merged.set(m.id, m);
		return merged as PrincipalMap;
	}, [data, map]);
	if (failed) return null;
	const events: Event[] = data?.events ?? [];
	const count = events.filter((e) => e.type === "message.posted").length;
	return (
		<div className="mb-4 rounded-card border border-line bg-bg">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-2 px-4 py-3 text-left"
			>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-14 font-semibold text-ink">
						来自{data?.conversationLabel ?? "原会话"}的话题“
						{data?.topic.title ?? "…"}”
					</span>
					<span className="text-12 text-muted">
						{data ? `${count} 条消息 · 只读` : "正在读取…"}
					</span>
				</span>
				<IconChevronRight
					size={16}
					className={cx(
						"shrink-0 text-muted transition-transform duration-150",
						open && "rotate-90",
					)}
				/>
			</button>
			{open && data ? (
				<div className="flex h-96 flex-col border-t border-line">
					<MessageList
						events={events}
						map={sourceMap}
						meId={meId}
						unreadAfter={null}
						handles={new Set()}
						isGroup
						onBottomChange={() => {}}
						empty={
							<p className="py-4 text-center text-13 text-muted">
								原话题里没有消息。
							</p>
						}
					/>
				</div>
			) : null}
		</div>
	);
}
