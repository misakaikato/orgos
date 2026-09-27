"use client";

import { type ReactNode, useEffect } from "react";
import { IconClose } from "@/components/icons";
import { IconButton } from "@/components/ui/button";

/**
 * 居中的对话框（转为任务、转成群聊）：遮罩点击或 Esc 关闭；卡片圆角、--shadow-float；
 * 手机上贴底铺满宽度。`footer` 放按钮行（主按钮最多一个）。
 */
export function Dialog({
	title,
	onClose,
	children,
	footer,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
	footer: ReactNode;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="fixed inset-0 z-40 flex items-end justify-center md:items-center">
			<button
				type="button"
				aria-label={`关闭${title}`}
				className="absolute inset-0 bg-scrim"
				onClick={onClose}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className="relative flex max-h-[85vh] w-full animate-pop-in flex-col rounded-card bg-bg shadow-float md:w-card md:max-w-[calc(100vw-32px)]"
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
				<footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
					{footer}
				</footer>
			</div>
		</div>
	);
}
