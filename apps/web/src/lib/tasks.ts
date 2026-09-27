/**
 * 任务在会话里的派生状态（纯函数，便于单测）。
 */
import { type Event, isTaskEnded, type Task } from "@orgos/protocol";
import type { TaskView } from "@/lib/store";

/** 会话里最近一个仍未结束的任务（按 task.created 的先后；任务尚未加载的跳过）。 */
export function currentTaskOf(
	events: readonly Event[] | undefined,
	tasks: Readonly<Record<string, TaskView>>,
): Task | null {
	const ids = (events ?? []).flatMap((e) =>
		e.type === "task.created" ? [e.payload.taskId] : [],
	);
	for (const id of ids.reverse()) {
		const task = tasks[id]?.task;
		if (task && !isTaskEnded(task.state)) return task;
	}
	return null;
}
