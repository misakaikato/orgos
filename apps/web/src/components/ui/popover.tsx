"use client";

import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { cx } from "@/lib/cx";

/** 点在 ref 之外（pointerdown）或按 Escape 时关闭。 */
export function useDismiss(
	ref: RefObject<HTMLElement | null>,
	open: boolean,
	onClose: () => void,
): void {
	useEffect(() => {
		if (!open) return;
		const onPointer = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [ref, open, onClose]);
}

/**
 * 锚在触发按钮旁的浮层（菜单、附件面板）：白底、--shadow-float、卡片圆角。
 * `trigger` 与浮层包在同一个定位容器里，点容器外即关闭。
 */
export function Popover({
	open,
	onClose,
	trigger,
	children,
	panelClassName,
	className,
}: {
	open: boolean;
	onClose: () => void;
	trigger: ReactNode;
	children: ReactNode;
	/** 浮层的定位与宽度，例如 `bottom-full left-0 mb-2 w-56`。 */
	panelClassName: string;
	className?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useDismiss(ref, open, onClose);
	return (
		<div ref={ref} className={cx("relative", className)}>
			{trigger}
			{open ? (
				<div
					className={cx(
						"absolute z-30 animate-pop-in overflow-hidden rounded-card bg-bg py-1 shadow-float",
						panelClassName,
					)}
				>
					{children}
				</div>
			) : null}
		</div>
	);
}

/** 浮层里的一行菜单项；给了 `checked` 就是一个开关项。 */
export function MenuItem({
	children,
	onClick,
	tone = "ink",
	disabled,
	checked,
}: {
	children: ReactNode;
	onClick?: () => void;
	tone?: "ink" | "danger";
	disabled?: boolean;
	checked?: boolean;
}) {
	const className = cx(
		"flex h-9 w-full items-center gap-2.5 px-3 text-left text-14 transition-colors duration-150 hover:bg-surface-2 disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent",
		tone === "danger" ? "text-danger" : "text-ink",
	);
	return checked === undefined ? (
		<button
			type="button"
			role="menuitem"
			disabled={disabled}
			onClick={onClick}
			className={className}
		>
			{children}
		</button>
	) : (
		<button
			type="button"
			role="menuitemcheckbox"
			aria-checked={checked}
			disabled={disabled}
			onClick={onClick}
			className={className}
		>
			{children}
		</button>
	);
}
