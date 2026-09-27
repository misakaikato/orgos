import { cx } from "@/lib/cx";
import { formatCount } from "@/lib/format";

/** 数字胶囊：未读 = --accent；待办 = --pending（DESIGN.md §4 会话列表行）。 */
export function Badge({
	count,
	tone = "unread",
	label,
	className,
}: {
	count: number;
	tone?: "unread" | "pending";
	label?: string;
	className?: string;
}) {
	if (count <= 0) return null;
	return (
		<span
			role="status"
			aria-label={label ?? `${count} 条未读`}
			className={cx(
				"inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-pill px-1.5 text-12 font-semibold leading-none tabular-nums",
				tone === "unread"
					? "bg-accent text-on-accent"
					: "bg-pending text-on-pending",
				className,
			)}
		>
			{formatCount(count)}
		</span>
	);
}

/** 行内小标签：会话行里的"代理在对外""协商"、气泡上方的"代林晓"。 */
export function Tag({
	children,
	tone = "neutral",
	className,
}: {
	children: string;
	tone?: "neutral" | "pending" | "good" | "danger";
	className?: string;
}) {
	return (
		<span
			className={cx(
				"inline-flex h-5 shrink-0 items-center rounded-pill px-2 text-12 leading-none whitespace-nowrap",
				tone === "neutral" && "bg-surface-2 text-muted",
				tone === "pending" && "bg-pending-soft text-pending-ink",
				tone === "good" && "bg-surface-2 text-ink",
				tone === "danger" && "bg-surface-2 text-danger",
				className,
			)}
		>
			{tone === "good" ? (
				<span
					aria-hidden="true"
					className="mr-1.5 size-1.5 rounded-pill bg-good"
				/>
			) : null}
			{children}
		</span>
	);
}
