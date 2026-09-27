"use client";

import type { Task } from "@orgos/protocol";
import { TaskStateTag } from "@/components/conversation/task-card";
import { Button } from "@/components/ui/button";

/**
 * 与外部助手私聊时输入框上方的一行：当前任务（发消息即追问它）与"新任务"按钮；
 * 切到新任务后，下一条消息开一个新任务（当前任务随之完成）。
 */
export function TaskBar({
	current,
	newTask,
	onToggle,
}: {
	current: Task | null;
	newTask: boolean;
	onToggle: () => void;
}) {
	if (!current)
		return (
			<p className="text-12 text-muted">发一条消息，就是交给它一个新任务。</p>
		);
	return (
		<div className="flex min-w-0 items-center gap-2 rounded-row border border-line bg-bg py-1 pr-1 pl-3">
			{newTask ? (
				<p className="min-w-0 flex-1 truncate text-13 text-ink">
					下一条消息会开一个新任务，当前任务随之完成。
				</p>
			) : (
				<>
					<span className="shrink-0 text-12 text-muted">当前任务</span>
					<span className="min-w-0 flex-1 truncate text-13 text-ink">
						{current.title}
					</span>
					<TaskStateTag state={current.state} />
				</>
			)}
			<Button onClick={onToggle}>{newTask ? "取消" : "新任务"}</Button>
		</div>
	);
}
