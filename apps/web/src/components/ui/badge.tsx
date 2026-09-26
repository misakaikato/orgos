import { cx } from "@/lib/cx";
import { formatCount } from "@/lib/format";

/** 数字徽章：未读 = 强调色实心胶囊；待办 = 琥珀实心胶囊。 */
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
				"inline-flex h-5 min-w-5 items-center justify-center rounded-capsule px-1 font-code text-12 font-medium leading-none tabular-nums text-surface",
				tone === "unread" ? "bg-accent" : "bg-pending",
				className,
			)}
		>
			{formatCount(count)}
		</span>
	);
}
