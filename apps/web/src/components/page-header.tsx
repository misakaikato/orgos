import Link from "next/link";
import type { ReactNode } from "react";
import { IconBack } from "@/components/icons";
import { appHref } from "@/lib/auth-mode";

/** 主区页头：窄屏带返回，标题可用页面级宋体。 */
export function PageHeader({
	title,
	actions,
}: {
	title: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 md:px-6">
			<Link
				href={appHref("/")}
				aria-label="返回会话列表"
				className="-ml-2 inline-flex size-8 items-center justify-center rounded-capsule text-muted hover:bg-surface-2 hover:text-ink md:hidden"
			>
				<IconBack />
			</Link>
			<h1 className="min-w-0 flex-1 truncate text-15 font-medium text-ink">
				{title}
			</h1>
			{actions}
		</header>
	);
}
