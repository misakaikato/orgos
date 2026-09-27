"use client";

import { type AcpPermissionOption, isAllowOption } from "@orgos/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { loadWorkItems, resolveWorkItem } from "@/lib/store";

type Pending = string | null;

function errorText(e: unknown): string {
	if (e instanceof ApiError && e.status === 409)
		return "这条审批已经处理过了（可能已过期或已取消）。";
	return e instanceof Error ? e.message : "操作失败，请重试。";
}

/**
 * 处理一条审批待办。设备操作：主按钮"允许"、次按钮"拒绝"；外部助手的请求：按它给出的选项
 * 各出一个按钮（第一个允许类为主按钮），所选选项原样回给它。
 * 会话里的审批卡片与待办页共用；处理结果经待办与 approval.resolved 事件回流。
 */
export function ApprovalActions({
	workItemId,
	options,
}: {
	workItemId: string;
	options?: readonly AcpPermissionOption[];
}) {
	const [pending, setPending] = useState<Pending>(null);
	const [error, setError] = useState<string | null>(null);

	const submit = async (
		key: string,
		action: "approve" | "deny",
		optionId?: string,
	) => {
		setPending(key);
		setError(null);
		try {
			await resolveWorkItem(workItemId, {
				action,
				...(optionId ? { optionId } : {}),
			});
		} catch (e) {
			setError(errorText(e));
			setPending(null);
			if (e instanceof ApiError && e.status === 409) void loadWorkItems();
		}
	};

	/** 主按钮：只允许这一次（没有就取第一个允许类选项）。 */
	const primary = (
		options?.find((o) => o.kind === "allow_once") ??
		options?.find(isAllowOption)
	)?.optionId;
	return (
		<div className="flex w-full flex-col gap-2">
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				{options ? (
					options.map((o) => (
						<Button
							key={o.optionId}
							variant={o.optionId === primary ? "primary" : "secondary"}
							disabled={pending !== null}
							onClick={() =>
								void submit(
									o.optionId,
									isAllowOption(o) ? "approve" : "deny",
									o.optionId,
								)
							}
						>
							{pending === o.optionId ? "正在提交…" : o.name}
						</Button>
					))
				) : (
					<>
						<Button
							variant="primary"
							disabled={pending !== null}
							onClick={() => void submit("approve", "approve")}
						>
							{pending === "approve" ? "正在允许…" : "允许"}
						</Button>
						<Button
							disabled={pending !== null}
							onClick={() => void submit("deny", "deny")}
						>
							{pending === "deny" ? "正在拒绝…" : "拒绝"}
						</Button>
					</>
				)}
			</div>
		</div>
	);
}
