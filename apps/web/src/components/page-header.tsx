import Link from "next/link";
import type { ReactNode } from "react";
import { IconBack } from "@/components/icons";
import { appHref } from "@/lib/auth-mode";

/** 主区页头（56px）：页面标题 20 半粗；`back` 给出时窄屏显示返回。 */
export function PageHeader({
	title,
	subtitle,
	back,
	actions,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	/** 窄屏返回的目标路径（不传则无返回按钮）。 */
	back?: string;
	actions?: ReactNode;
}) {
	return (
		<header className="flex h-header shrink-0 border-b border-line bg-bg">
			<div className="mx-auto flex w-full max-w-thread items-center gap-2 px-3 md:px-6">
				{back ? (
					<Link
						href={appHref(back)}
						aria-label="返回"
						className="inline-flex size-8 items-center justify-center rounded-pill text-ink hover:bg-surface-2 md:hidden"
					>
						<IconBack />
					</Link>
				) : null}
				<div className="flex min-w-0 flex-1 items-baseline gap-2 px-1">
					<h1 className="truncate text-20 font-semibold text-ink">{title}</h1>
					{subtitle ? (
						<span className="truncate text-13 text-muted">{subtitle}</span>
					) : null}
				</div>
				{actions}
			</div>
		</header>
	);
}
