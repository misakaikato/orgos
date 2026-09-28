"use client";

import { RESOLUTION_TEXT_MAX_LENGTH } from "@orgos/protocol";
import {
	type FormEvent,
	type KeyboardEvent,
	useId,
	useRef,
	useState,
} from "react";
import { IconCheck, IconPlus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { cx } from "@/lib/cx";
import {
	answerRequest,
	choiceAfterEdit,
	type DecisionChoice,
} from "@/lib/decision";
import { loadWorkItems, resolveWorkItem } from "@/lib/store";

type Pending = "answer" | "decline" | null;

function errorText(e: unknown): string {
	if (e instanceof ApiError && e.status === 409) return "这件事已经处理过了。";
	return e instanceof Error ? e.message : "操作失败，请重试。";
}

/**
 * 答复分身转来的问题（decision 待办）：分身给的候选（可选）+ 答复框 + "存为共享资料"
 * + 主按钮"答复"、次按钮"暂不答复"。
 * 会话里的上报卡片与待办页共用；处理结果经事件与待办推送回流，本组件不保存处理后的状态。
 */
export function DecisionForm({
	workItemId,
	requesterName,
	negotiating = false,
	options = [],
}: {
	workItemId: string;
	/** 提问的人，用于占位提示。 */
	requesterName: string;
	/** 分身在协商中请你拍板：答复后它据此接着协商，而不是转告提问的人。 */
	negotiating?: boolean;
	/** 分身给出的候选答复。 */
	options?: readonly string[];
}) {
	const [text, setText] = useState("");
	const [choice, setChoice] = useState<DecisionChoice>(null);
	const [saveAsNote, setSaveAsNote] = useState(false);
	const [pending, setPending] = useState<Pending>(null);
	const [error, setError] = useState<string | null>(null);
	const inputId = useId();
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const answer = text.trim();

	const choose = (next: Exclude<DecisionChoice, null>) => {
		setChoice(next);
		if (next === "custom") {
			setText("");
			inputRef.current?.focus();
		} else setText(options[next] ?? "");
	};

	const submit = async (action: "answer" | "decline") => {
		const req =
			action === "answer"
				? answerRequest(text, options, choice, saveAsNote)
				: { action, ...(answer ? { text: answer } : {}) };
		if (!req) return;
		setPending(action);
		setError(null);
		try {
			await resolveWorkItem(workItemId, req);
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

	/** 焦点不在答复框时，数字键 1–4 直接选候选。 */
	const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
		if (pending !== null || e.target instanceof HTMLTextAreaElement) return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const n = Number(e.key);
		if (Number.isInteger(n) && n >= 1 && n <= options.length) {
			e.preventDefault();
			choose(n - 1);
		}
	};

	return (
		<form
			onSubmit={onSubmit}
			onKeyDown={onKeyDown}
			className="mt-3 flex flex-col gap-3"
		>
			{options.length > 0 ? (
				<OptionList
					options={options}
					choice={choice}
					disabled={pending !== null}
					onChoose={choose}
				/>
			) : null}
			<label htmlFor={inputId} className="sr-only">
				你的答复
			</label>
			<textarea
				ref={inputRef}
				id={inputId}
				rows={3}
				value={text}
				maxLength={RESOLUTION_TEXT_MAX_LENGTH}
				disabled={pending !== null}
				placeholder={
					negotiating
						? "写下你的决定，分身会据此接着协商"
						: `写下答复，分身会转告${requesterName}`
				}
				onChange={(e) => {
					setText(e.target.value);
					setChoice((c) => choiceAfterEdit(c, options, e.target.value));
				}}
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

/**
 * 候选答复：每项一个可选中的按钮（aria-pressed），前面是数字键提示；最后一项固定为"自己写"。
 */
function OptionList({
	options,
	choice,
	disabled,
	onChoose,
}: {
	options: readonly string[];
	choice: DecisionChoice;
	disabled: boolean;
	onChoose: (choice: Exclude<DecisionChoice, null>) => void;
}) {
	const items: { key: Exclude<DecisionChoice, null>; label: string }[] = [
		...options.map((label, i) => ({ key: i, label })),
		{ key: "custom" as const, label: "自己写" },
	];
	return (
		<fieldset className="flex flex-col gap-2" disabled={disabled}>
			<legend className="mb-2 text-12 text-muted">
				选一个答复，或自己写（数字键 1–{options.length} 可直接选）
			</legend>
			{items.map(({ key, label }) => {
				const selected = choice === key;
				const custom = key === "custom";
				return (
					<button
						key={key}
						type="button"
						aria-pressed={selected}
						onClick={() => onChoose(key)}
						className={cx(
							"flex w-full items-start gap-2 rounded-row border px-3 py-2 text-left text-14 transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50",
							selected
								? "border-accent bg-accent-soft"
								: "border-line bg-bg hover:bg-surface-2",
							custom && !selected ? "text-muted" : "text-ink",
						)}
					>
						<span
							aria-hidden="true"
							className={cx(
								"mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-pill text-12 font-medium",
								selected
									? "bg-accent text-on-accent"
									: "bg-surface-2 text-muted",
							)}
						>
							{selected ? (
								<IconCheck size={12} />
							) : custom ? (
								<IconPlus size={12} />
							) : (
								Number(key) + 1
							)}
						</span>
						<span className="min-w-0 flex-1 break-words">{label}</span>
					</button>
				);
			})}
		</fieldset>
	);
}
