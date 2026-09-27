"use client";

import { type ReactNode, useEffect } from "react";
import { IconClose } from "@/components/icons";
import { IconButton } from "@/components/ui/button";

/**
 * 右侧抽屉（协商过程、任务过程）：遮罩点击或 Esc 关闭，宽同检查器，头部 56px 标题 + 关闭。
 */
export function SideDrawer({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="fixed inset-0 z-30 flex justify-end">
			<button
				type="button"
				aria-label={`关闭${title}`}
				className="flex-1 bg-scrim"
				onClick={onClose}
			/>
			<aside
				aria-label={title}
				className="flex h-full w-inspector max-w-full animate-pop-in flex-col bg-bg shadow-float"
			>
				<header className="flex h-header shrink-0 items-center justify-between gap-2 border-b border-line px-4">
					<h2 className="text-16 font-semibold text-ink">{title}</h2>
					<IconButton label="关闭" onClick={onClose}>
						<IconClose size={18} />
					</IconButton>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
					{children}
				</div>
			</aside>
		</div>
	);
}
