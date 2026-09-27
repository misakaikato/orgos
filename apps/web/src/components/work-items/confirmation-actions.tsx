"use client";

import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { loadWorkItems, resolveWorkItem } from "@/lib/store";

type Pending = "confirm" | "reject" | null;

function errorText(e: unknown): string {
	if (e instanceof ApiError && e.status === 409)
		return "这个结果已经处理过了（可能对方已驳回）。";
	return e instanceof Error ? e.message : "操作失败，请重试。";
}

/**
 * 确认或驳回协商结果（confirmation 待办）：主按钮"确认"、危险按钮"驳回"。
 * 私聊里的协商卡片与待办页共用；处理结果经待办与协商事件回流，本组件不保存处理后的状态。
 */
export function ConfirmationActions({
	workItemId,
	children,
}: {
	workItemId: string;
	/** 跟在两个按钮后面的次要操作。 */
	children?: ReactNode;
}) {
	const [pending, setPending] = useState<Pending>(null);
	const [error, setError] = useState<string | null>(null);

	const submit = async (action: "confirm" | "reject") => {
		setPending(action);
		setError(null);
		try {
			await resolveWorkItem(workItemId, { action });
		} catch (e) {
			setError(errorText(e));
			setPending(null);
			if (e instanceof ApiError && e.status === 409) void loadWorkItems();
		}
	};

	return (
		<div className="flex w-full flex-col gap-2">
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					variant="primary"
					disabled={pending !== null}
					onClick={() => void submit("confirm")}
				>
					{pending === "confirm" ? "正在确认…" : "确认"}
				</Button>
				<Button
					variant="danger"
					disabled={pending !== null}
					onClick={() => void submit("reject")}
				>
					{pending === "reject" ? "正在驳回…" : "驳回"}
				</Button>
				{children}
			</div>
		</div>
	);
}
