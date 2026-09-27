import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import { cx } from "@/lib/cx";

/** 输入框：--surface-2 底、无描边，聚焦时 2px 品牌色外环。 */
export const fieldClass =
	"w-full bg-surface-2 text-14 text-ink placeholder:text-muted outline-none focus-visible:outline-none focus:ring-2 focus:ring-accent";

export function Input({
	className,
	...rest
}: InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			className={cx(fieldClass, "h-10 rounded-pill px-4", className)}
			{...rest}
		/>
	);
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
	label: string;
	hint?: ReactNode;
	error?: string | null;
};

/** 带标签、说明与错误提示的单行输入。 */
export function Field({
	label,
	hint,
	error,
	id,
	className,
	...rest
}: FieldProps) {
	const auto = useId();
	const inputId = id ?? auto;
	const noteId = `${inputId}-note`;
	return (
		<div className={cx("flex flex-col gap-1.5", className)}>
			<label htmlFor={inputId} className="text-13 font-medium text-ink">
				{label}
			</label>
			<Input
				id={inputId}
				aria-invalid={error ? true : undefined}
				aria-describedby={hint || error ? noteId : undefined}
				{...rest}
			/>
			{error ? (
				<p id={noteId} className="text-12 text-danger">
					{error}
				</p>
			) : hint ? (
				<p id={noteId} className="text-12 text-muted">
					{hint}
				</p>
			) : null}
		</div>
	);
}
