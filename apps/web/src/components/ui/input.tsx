import type {
	InputHTMLAttributes,
	ReactNode,
	TextareaHTMLAttributes,
} from "react";
import { useId } from "react";
import { cx } from "@/lib/cx";

const selectBase =
	"h-control w-full rounded-pill px-3 text-14 text-ink outline-none focus:ring-2 focus:ring-accent disabled:opacity-50";

/** 下拉选择：与输入框同一套底色与聚焦外环。 */
export const selectClass = `${selectBase} bg-surface-2`;

/** 放在 --surface-2 底色区块里的下拉选择。 */
export const selectOnSurfaceClass = `${selectBase} bg-bg`;

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

/** 多行输入：与单行同底色，卡片圆角，可纵向拉伸。 */
export function TextAreaField({
	label,
	hint,
	id,
	className,
	...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
	label: string;
	hint?: ReactNode;
}) {
	const auto = useId();
	const inputId = id ?? auto;
	const noteId = `${inputId}-note`;
	return (
		<div className={cx("flex flex-col gap-1.5", className)}>
			<label htmlFor={inputId} className="text-13 font-medium text-ink">
				{label}
			</label>
			<textarea
				id={inputId}
				rows={3}
				aria-describedby={hint ? noteId : undefined}
				className={cx(fieldClass, "min-h-20 resize-y rounded-card px-4 py-2.5")}
				{...rest}
			/>
			{hint ? (
				<p id={noteId} className="text-12 text-muted">
					{hint}
				</p>
			) : null}
		</div>
	);
}

/** 开关：胶囊轨道 + 圆钮；开时轨道为品牌色。 */
export function Switch({
	checked,
	onChange,
	label,
	disabled,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	/** 无障碍名称。 */
	label: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cx(
				"relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill transition-colors duration-150 disabled:opacity-50",
				checked ? "bg-accent" : "bg-line",
			)}
		>
			<span
				aria-hidden="true"
				className={cx(
					"size-4 rounded-pill bg-bg shadow-card-hover transition-transform duration-150",
					checked ? "translate-x-4.5" : "translate-x-0.5",
				)}
			/>
		</button>
	);
}
