"use client";

import {
	isTaskEnded,
	type Principal,
	type Task,
	type TaskLog,
	type TaskState,
} from "@orgos/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CardRow, MessageCard } from "@/components/conversation/cards";
import {
	AgentName,
	fallbackPrincipal,
} from "@/components/conversation/message-item";
import { IconCheck, IconChevronRight, IconClose } from "@/components/icons";
import { Mascot } from "@/components/mascot";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SideDrawer } from "@/components/ui/drawer";
import { LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { nameOf, TASK_STATE_LABEL } from "@/lib/describe";
import { formatClock, formatStamp } from "@/lib/format";
import type { PrincipalMap } from "@/lib/principals";
import {
	cancelTask,
	completeTask,
	ensureTask,
	loadTask,
	useStore,
} from "@/lib/store";
import type { TaskRef } from "@/lib/thread";

const STATE_TONE: Record<TaskState, "neutral" | "pending" | "good" | "danger"> =
	{
		submitted: "neutral",
		working: "neutral",
		input_required: "neutral",
		awaiting_approval: "pending",
		completed: "good",
		failed: "danger",
		canceled: "neutral",
	};

/** 任务状态胶囊。 */
export function TaskStateTag({ state }: { state: TaskState }) {
	return <Tag tone={STATE_TONE[state]}>{TASK_STATE_LABEL[state]}</Tag>;
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : "操作失败，请重试。";
}

/** 结束外部任务的两个按钮：完成（主）与停止（危险）。 */
function EndActions({ task }: { task: Task }) {
	const [pending, setPending] = useState<"complete" | "cancel" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const run = async (action: "complete" | "cancel") => {
		setPending(action);
		setError(null);
		try {
			await (action === "complete" ? completeTask : cancelTask)(task.id);
		} catch (e) {
			setError(errorText(e));
			void loadTask(task.id);
		} finally {
			setPending(null);
		}
	};
	return (
		<>
			<Button
				variant="primary"
				disabled={pending !== null}
				onClick={() => void run("complete")}
			>
				{pending === "complete" ? "正在完成…" : "完成"}
			</Button>
			<Button
				variant="danger"
				disabled={pending !== null}
				onClick={() => void run("cancel")}
			>
				{pending === "cancel" ? "正在停止…" : "停止"}
			</Button>
			{error ? (
				<p role="alert" className="w-full text-12 text-danger">
					{error}
				</p>
			) : null}
		</>
	);
}

/**
 * 任务卡片：执行者的团子（进行中 working）与名字、标题、状态胶囊、最新进度摘要、产出列表；
 * 外部任务的本人看到"完成 / 停止"；所有人都能"查看过程"（右侧抽屉按日志时间线展示）。
 */
export function TaskCard({
	task: ref,
	map,
	meId,
}: {
	task: TaskRef;
	map: PrincipalMap;
	meId: string;
}) {
	const { taskId } = ref;
	const view = useStore((s) => s.tasks[taskId]);
	const status = useStore((s) => s.tasksStatus[taskId]);
	const [drawer, setDrawer] = useState(false);
	useEffect(() => {
		ensureTask(taskId);
	}, [taskId]);

	const task = view?.task;
	const assignee: Pick<
		Principal,
		"id" | "kind" | "handle" | "displayName" | "ownerId"
	> =
		view?.assignee ??
		map.get(ref.actorId) ??
		fallbackPrincipal(ref.actorId, "agent");
	const mine =
		task?.engine === "acp" &&
		assignee.ownerId === meId &&
		!isTaskEnded(task.state);
	const waitingMe =
		task?.state === "awaiting_approval" && assignee.ownerId === meId;
	const openDrawer = <Button onClick={() => setDrawer(true)}>查看过程</Button>;
	return (
		<CardRow actorId={ref.actorId} map={map}>
			<MessageCard
				pending={waitingMe}
				title={task?.title ?? ref.title}
				meta={formatClock(task?.updatedAt ?? ref.createdAt)}
				actions={
					task ? (
						<>
							{mine ? <EndActions task={task} /> : null}
							{openDrawer}
						</>
					) : null
				}
			>
				<div className="flex items-center gap-2">
					<Mascot
						id={assignee.id}
						size={24}
						state={task?.state === "working" ? "working" : "idle"}
					/>
					<span className="min-w-0 flex-1">
						<AgentName agent={assignee} map={map} meId={meId} />
					</span>
					{task ? <TaskStateTag state={task.state} /> : null}
				</div>
				{!task ? (
					status === "error" ? (
						<p className="mt-2 text-13 text-danger">任务读取失败。</p>
					) : (
						<p className="mt-2 text-13 text-muted">正在读取任务…</p>
					)
				) : (
					<>
						<p
							className={cx(
								"mt-2 line-clamp-6 text-14 whitespace-pre-wrap break-words",
								task.resultSummary ? "text-ink" : "text-muted",
							)}
						>
							{task.resultSummary ||
								(task.state === "working" ? "正在处理…" : "还没有进展。")}
						</p>
						{waitingMe ? (
							<p className="mt-2 text-12 text-muted">
								它在等你批准，审批卡片在下面。
							</p>
						) : null}
						{task.artifacts.length > 0 ? (
							<div className="mt-3">
								<p className="text-12 text-muted">产出</p>
								<ul className="mt-1 flex flex-col gap-1">
									{task.artifacts.map((a) => (
										<li
											key={`${a.kind}:${a.ref}`}
											className="truncate text-13 text-ink"
											title={a.ref}
										>
											{a.ref}
										</li>
									))}
								</ul>
							</div>
						) : null}
					</>
				)}
			</MessageCard>
			{drawer && task ? (
				<TaskDrawer
					task={task}
					assignee={assignee}
					map={map}
					meId={meId}
					onClose={() => setDrawer(false)}
				/>
			) : null}
		</CardRow>
	);
}

/** 过程日志：打开时全量读取，任务每次变化后补读新增的条目。 */
function useTaskLog(task: Task) {
	const [items, setItems] = useState<TaskLog[] | null>(null);
	const [failed, setFailed] = useState(false);
	const last = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 任务每次变化（updatedAt）都补读一次。
	useEffect(() => {
		let alive = true;
		api
			.taskLog(task.id, last.current)
			.then(({ items: more }) => {
				if (!alive || more.length === 0) return;
				last.current = more.at(-1)?.seq ?? last.current;
				setItems((prev) => [...(prev ?? []), ...more]);
			})
			.catch(() => {
				if (alive) setFailed(true);
			})
			.finally(() => {
				if (alive) setItems((prev) => prev ?? []);
			});
		return () => {
			alive = false;
		};
	}, [task.id, task.updatedAt]);
	return { items, failed };
}

/** 可以展开的一行（工具调用、权限请求的细节）。 */
function Fold({ lead, children }: { lead: ReactNode; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="inline-flex max-w-full items-center gap-1 text-left text-13 text-ink hover:text-accent"
			>
				<span className="min-w-0 break-words">{lead}</span>
				<IconChevronRight
					size={14}
					className={cx(
						"shrink-0 text-muted transition-transform duration-150",
						open && "rotate-90",
					)}
				/>
			</button>
			{open ? <div className="mt-1">{children}</div> : null}
		</div>
	);
}

function CodeBlock({ text }: { text: string }) {
	return (
		<pre className="max-h-64 overflow-auto rounded-row bg-surface-2 px-3 py-2 font-code text-12 whitespace-pre-wrap break-all text-ink">
			{text}
		</pre>
	);
}

function jsonText(v: unknown): string {
	return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

type Payload = Record<string, unknown>;

function str(p: Payload, k: string): string | undefined {
	const v = p[k];
	return typeof v === "string" ? v : undefined;
}

/** 权限请求里出现过的选项：optionId → 名字（结果那一条只记了 optionId）。 */
function optionNames(items: readonly TaskLog[]): Map<string, string> {
	const names = new Map<string, string>();
	for (const log of items) {
		if (log.kind !== "permission") continue;
		const options = (log.payload as { options?: unknown }).options;
		if (!Array.isArray(options)) continue;
		for (const o of options as { optionId?: unknown; name?: unknown }[])
			if (typeof o.optionId === "string" && typeof o.name === "string")
				names.set(o.optionId, o.name);
	}
	return names;
}

function LogEntry({
	log,
	assignee,
	map,
	meId,
	options,
}: {
	log: TaskLog;
	assignee: Pick<Principal, "id" | "displayName">;
	map: PrincipalMap;
	meId: string;
	options: ReadonlyMap<string, string>;
}) {
	const p = (log.payload ?? {}) as Payload;
	switch (log.kind) {
		case "prompt": {
			const by = str(p, "byId");
			return (
				<div className="flex flex-col gap-1">
					<p className="text-12 text-muted">
						{by ? nameOf(by, map, meId) : "交办人"}
						{log.seq === 1 ? "交办" : "追问"}
					</p>
					<p className="rounded-row bg-accent-soft px-3 py-2 text-14 whitespace-pre-wrap break-words text-ink">
						{str(p, "text")}
					</p>
				</div>
			);
		}
		case "agent_text":
			return (
				<div className="flex items-start gap-2">
					<Mascot id={assignee.id} size={24} />
					<p className="min-w-0 flex-1 rounded-row border border-line px-3 py-2 text-14 whitespace-pre-wrap break-words text-ink">
						{str(p, "text")?.trim()}
					</p>
				</div>
			);
		case "tool_call":
			return (
				<Fold lead={`调用工具：${str(p, "title") ?? "工具"}`}>
					{p.input === undefined ? (
						<p className="text-12 text-muted">没有参数</p>
					) : (
						<CodeBlock text={jsonText(p.input)} />
					)}
				</Fold>
			);
		case "tool_result": {
			const ok = p.ok === true;
			const lead = (
				<span className="inline-flex items-center gap-1">
					{ok ? (
						<IconCheck size={14} className="shrink-0 text-good" />
					) : (
						<IconClose size={14} className="shrink-0 text-danger" />
					)}
					{str(p, "title") ?? "工具结果"}
				</span>
			);
			const output = str(p, "output");
			return output ? (
				<Fold lead={lead}>
					<CodeBlock text={output} />
				</Fold>
			) : (
				<p className="text-13 text-ink">{lead}</p>
			);
		}
		case "permission": {
			const title = str(p, "title") ?? "操作";
			const auto = str(p, "auto");
			if (auto)
				return (
					<p className="text-13 text-muted break-words">
						{`${title}：${auto}，直接执行`}
					</p>
				);
			const outcome = str(p, "outcome");
			if (outcome) {
				const optionId = str(p, "optionId");
				return (
					<p className="text-13 text-muted break-words">
						{`权限请求的结果：${
							outcome === "approve"
								? "已允许"
								: outcome === "deny"
									? "已拒绝"
									: outcome === "expired"
										? "10 分钟内没有处理，视为拒绝"
										: "已取消"
						}${optionId ? `：${options.get(optionId) ?? optionId}` : ""}`}
					</p>
				);
			}
			return (
				<Fold lead={`请求权限：${title}`}>
					{p.input === undefined ? null : (
						<CodeBlock text={jsonText(p.input)} />
					)}
				</Fold>
			);
		}
		case "state": {
			const state = str(p, "state") ?? "";
			const label =
				state in TASK_STATE_LABEL
					? TASK_STATE_LABEL[state as TaskState]
					: state === "ready"
						? "外部会话已建立"
						: state;
			return (
				<p className="flex items-center gap-2 text-12 text-muted">
					<span aria-hidden="true" className="size-1.5 rounded-pill bg-line" />
					{str(p, "note") ?? label}
				</p>
			);
		}
		case "error":
			return (
				<p role="alert" className="text-13 break-words text-danger">
					{str(p, "message")}
				</p>
			);
	}
}

/** 任务过程抽屉：按时间线展示日志（文字、工具调用、权限请求折叠）。 */
function TaskDrawer({
	task,
	assignee,
	map,
	meId,
	onClose,
}: {
	task: Task;
	assignee: Pick<Principal, "id" | "displayName">;
	map: PrincipalMap;
	meId: string;
	onClose: () => void;
}) {
	const { items, failed } = useTaskLog(task);
	const options = optionNames(items ?? []);
	return (
		<SideDrawer title="任务过程" onClose={onClose}>
			<p className="text-12 text-muted">任务</p>
			<p className="mt-1 text-14 font-semibold break-words text-ink">
				{task.title}
			</p>
			<div className="mt-2 flex items-center gap-2 text-12 text-muted">
				<TaskStateTag state={task.state} />
				<span>{formatStamp(task.createdAt)} 交办</span>
			</div>
			{failed && !items?.length ? (
				<p role="alert" className="mt-4 text-13 text-danger">
					过程读取失败，关掉抽屉再打开试试。
				</p>
			) : items === null ? (
				<LoadingRows rows={3} />
			) : (
				<ol className="mt-4 flex flex-col gap-3 border-l-2 border-line pl-4">
					{items.map((log) => (
						<li key={log.id} className="min-w-0">
							<LogEntry
								log={log}
								assignee={assignee}
								map={map}
								meId={meId}
								options={options}
							/>
						</li>
					))}
				</ol>
			)}
		</SideDrawer>
	);
}
