import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cx } from "@/lib/cx";

export type EmptyAction =
	| { label: string; href: string }
	| { label: string; onClick: () => void };

function ActionLink({ action }: { action: EmptyAction }) {
	const cls =
		"text-13 font-medium text-ink underline decoration-line underline-offset-4 hover:decoration-ink";
	return "href" in action ? (
		<Link href={action.href} className={cls}>
			{action.label}
		</Link>
	) : (
		<button type="button" onClick={action.onClick} className={cls}>
			{action.label}
		</button>
	);
}

/** 空状态：一句说明 + 一个能立刻做的动作（DESIGN.md §5）。 */
export function EmptyState({
	text,
	action,
	compact,
	className,
}: {
	text: string;
	action?: EmptyAction;
	compact?: boolean;
	className?: string;
}) {
	return (
		<div
			className={cx(
				"flex flex-col gap-2",
				compact
					? "items-start px-4 py-2"
					: "items-center justify-center px-6 py-12 text-center",
				className,
			)}
		>
			<p className={cx("text-muted", compact ? "text-13" : "text-14")}>
				{text}
			</p>
			{action ? <ActionLink action={action} /> : null}
		</div>
	);
}

/** 加载态：几行占位条，形状贴近将要出现的内容。 */
export function LoadingRows({
	rows = 3,
	className,
}: {
	rows?: number;
	className?: string;
}) {
	return (
		<div
			role="status"
			aria-busy="true"
			aria-label="加载中"
			className={cx("flex flex-col gap-3 p-4", className)}
		>
			{Array.from({ length: rows }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 静态占位行，没有身份可言。
				<div key={i} className="flex items-center gap-3">
					<span className="size-8 shrink-0 animate-pulse rounded-full bg-surface-2" />
					<span className="flex flex-1 flex-col gap-2">
						<span className="h-3 w-1/3 animate-pulse rounded-capsule bg-surface-2" />
						<span className="h-3 w-2/3 animate-pulse rounded-capsule bg-surface-2" />
					</span>
				</div>
			))}
		</div>
	);
}

/** 错误态：说明 + 重试。 */
export function ErrorState({
	text,
	onRetry,
	className,
}: {
	text: string;
	onRetry?: () => void;
	className?: string;
}) {
	return (
		<div
			role="alert"
			className={cx(
				"flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
				className,
			)}
		>
			<p className="text-14 text-danger">{text}</p>
			{onRetry ? <Button onClick={onRetry}>重试</Button> : null}
		</div>
	);
}
