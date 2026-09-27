"use client";

import type { ReactNode } from "react";
import { Mascot } from "@/components/mascot";
import { Button, ButtonLink, SoonButton } from "@/components/ui/button";
import { cx } from "@/lib/cx";

export type EmptyAction =
	| { label: string; href: string }
	| { label: string; onClick: () => void }
	| { label: string; soon: true };

function ActionButton({ action }: { action: EmptyAction }) {
	if ("href" in action)
		return (
			<ButtonLink variant="primary" href={action.href}>
				{action.label}
			</ButtonLink>
		);
	if ("soon" in action)
		return <SoonButton variant="primary">{action.label}</SoonButton>;
	return (
		<Button variant="primary" onClick={action.onClick}>
			{action.label}
		</Button>
	);
}

/**
 * 空状态：一只大号团子（72px，idle）+ 一句话 + 一个主按钮（DESIGN.md §5）。
 * `mascotId` 决定是哪只团子；页面内同一处空状态用固定 id，形象就不会变。
 */
export function EmptyState({
	text,
	action,
	mascotId = "orgos-empty",
	compact,
	children,
	className,
}: {
	text: string;
	action?: EmptyAction;
	mascotId?: string;
	/** 列表里的小号空状态：团子 40，左对齐。 */
	compact?: boolean;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cx(
				"flex items-center",
				compact
					? "gap-3 px-4 py-3"
					: "flex-col justify-center gap-4 px-6 py-12 text-center",
				className,
			)}
		>
			<Mascot id={mascotId} size={compact ? 40 : 72} />
			<div
				className={cx(
					"flex flex-col gap-3",
					compact ? "items-start" : "items-center",
				)}
			>
				<p
					className={cx(
						"max-w-xs text-muted",
						compact ? "text-13" : "text-14 text-balance",
					)}
				>
					{text}
				</p>
				{children}
				{action ? <ActionButton action={action} /> : null}
			</div>
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
			className={cx("flex flex-col gap-4 p-4", className)}
		>
			{Array.from({ length: rows }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 静态占位行，没有身份可言。
				<div key={i} className="flex items-center gap-3">
					<span className="size-10 shrink-0 animate-pulse rounded-pill bg-surface-2" />
					<span className="flex flex-1 flex-col gap-2">
						<span className="h-3 w-1/3 animate-pulse rounded-pill bg-surface-2" />
						<span className="h-3 w-2/3 animate-pulse rounded-pill bg-surface-2" />
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
