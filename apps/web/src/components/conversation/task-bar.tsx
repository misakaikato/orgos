"use client";

import { Button } from "@/components/ui/button";

/**
 * 与自己代理私聊时输入框上方的一行"新任务"开关：打开后，下一条消息新开一个任务话题（目标即这条消息），
 * 发送后跳到那个话题。
 */
export function NewTaskToggle({
	on,
	onToggle,
}: {
	on: boolean;
	onToggle: () => void;
}) {
	return (
		<div className="flex min-w-0 items-center gap-2 rounded-row border border-line bg-bg py-1 pr-1 pl-3">
			<p className="min-w-0 flex-1 truncate text-13 text-muted">
				{on
					? "下一条消息会新开一个任务话题，任务目标就是这条消息。"
					: "消息发在当前话题；要另起一件带状态的事，可以开一个新任务。"}
			</p>
			<Button onClick={onToggle}>{on ? "取消" : "新任务"}</Button>
		</div>
	);
}
