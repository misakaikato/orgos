"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { loadWorkItems, resolveWorkItem } from "@/lib/store";

type Pending = "approve" | "deny" | null;

function errorText(e: unknown): string {
	if (e instanceof ApiError && e.status === 409)
		return "这条审批已经处理过了（可能已过期或已取消）。";
	return e instanceof Error ? e.message : "操作失败，请重试。";
}

/**
 * 允许或拒绝一次设备操作（approval 待办）：主按钮"允许"、次按钮"拒绝"。
 * 会话里的审批卡片与待办页共用；处理结果经待办与 approval.resolved 事件回流。
 */
export function ApprovalActions({ workItemId }: { workItemId: string }) {
	const [pending, setPending] = useState<Pending>(null);
	const [error, setError] = useState<string | null>(null);

	const submit = async (action: "approve" | "deny") => {
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
					onClick={() => void submit("approve")}
				>
					{pending === "approve" ? "正在允许…" : "允许"}
				</Button>
				<Button disabled={pending !== null} onClick={() => void submit("deny")}>
					{pending === "deny" ? "正在拒绝…" : "拒绝"}
				</Button>
			</div>
		</div>
	);
}
