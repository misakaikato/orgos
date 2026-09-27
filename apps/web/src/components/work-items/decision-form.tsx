"use client";

import { RESOLUTION_TEXT_MAX_LENGTH } from "@orgos/protocol";
import { type FormEvent, useId, useState } from "react";
import { IconCheck } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { cx } from "@/lib/cx";
import { loadWorkItems, resolveWorkItem } from "@/lib/store";

type Pending = "answer" | "decline" | null;

function errorText(e: unknown): string {
	if (e instanceof ApiError && e.status === 409) return "这件事已经处理过了。";
	return e instanceof Error ? e.message : "操作失败，请重试。";
}

/**
 * 答复分身转来的问题（decision 待办）：答复框 + "存为共享资料" + 主按钮"答复"、次按钮"暂不答复"。
 * 会话里的上报卡片与待办页共用；处理结果经事件与待办推送回流，本组件不保存处理后的状态。
 */
export function DecisionForm({
	workItemId,
	requesterName,
}: {
	workItemId: string;
	/** 提问的人，用于占位提示。 */
	requesterName: string;
}) {
	const [text, setText] = useState("");
	const [saveAsNote, setSaveAsNote] = useState(false);
	const [pending, setPending] = useState<Pending>(null);
	const [error, setError] = useState<string | null>(null);
	const inputId = useId();
	const answer = text.trim();

	const submit = async (action: "answer" | "decline") => {
		setPending(action);
		setError(null);
		try {
			await resolveWorkItem(
				workItemId,
				action === "answer"
					? { action, text: answer, ...(saveAsNote ? { saveAsNote } : {}) }
					: { action, ...(answer ? { text: answer } : {}) },
			);
		} catch (e) {
			setError(errorText(e));
			setPending(null);
			if (e instanceof ApiError && e.status === 409) void loadWorkItems();
		}
	};

	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		if (answer && !pending) void submit("answer");
	};

	return (
		<form onSubmit={onSubmit} className="mt-3 flex flex-col gap-3">
			<label htmlFor={inputId} className="sr-only">
				你的答复
			</label>
			<textarea
				id={inputId}
				rows={3}
				value={text}
				maxLength={RESOLUTION_TEXT_MAX_LENGTH}
				disabled={pending !== null}
				placeholder={`写下答复，分身会转告${requesterName}`}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit(e);
				}}
				className={cx(fieldClass, "min-h-20 resize-y rounded-card px-3 py-2")}
			/>
			<label className="flex w-fit cursor-pointer items-center gap-2 text-13 text-ink">
				<input
					type="checkbox"
					className="peer sr-only"
					checked={saveAsNote}
					disabled={pending !== null}
					onChange={(e) => setSaveAsNote(e.target.checked)}
				/>
				<span
					aria-hidden="true"
					className={cx(
						"inline-flex size-4.5 shrink-0 items-center justify-center rounded-pill border-2 transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-accent",
						saveAsNote
							? "border-accent bg-accent text-on-accent"
							: "border-line text-transparent",
					)}
				>
					<IconCheck size={12} />
				</span>
				存为共享资料
				<span className="text-12 text-muted">以后分身可以直接答</span>
			</label>
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					type="submit"
					variant="primary"
					disabled={!answer || pending !== null}
				>
					{pending === "answer" ? "正在答复…" : "答复"}
				</Button>
				<Button
					disabled={pending !== null}
					onClick={() => void submit("decline")}
				>
					{pending === "decline" ? "正在处理…" : "暂不答复"}
				</Button>
			</div>
		</form>
	);
}
