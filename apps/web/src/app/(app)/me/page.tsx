"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
	IconAgents,
	IconChevronRight,
	IconDevice,
	IconLogout,
} from "@/components/icons";
import { useSignOut } from "@/components/nav-rail";
import { PageHeader } from "@/components/page-header";
import { ThemeSegmented } from "@/components/theme";
import { PersonAvatar } from "@/components/ui/avatar";
import { appHref } from "@/lib/auth-mode";
import { useStore } from "@/lib/store";

function Row({
	href,
	icon,
	children,
}: {
	href: string;
	icon: ReactNode;
	children: ReactNode;
}) {
	return (
		<Link
			href={appHref(href)}
			className="flex h-12 items-center gap-3 px-4 text-14 text-ink transition-colors duration-150 hover:bg-surface-2"
		>
			<span className="text-muted">{icon}</span>
			<span className="flex-1">{children}</span>
			<IconChevronRight size={16} className="text-muted" />
		</Link>
	);
}

/** 我的（手机底部标签）：身份、代理组与设备入口、主题、退出。 */
export default function MePage() {
	const me = useStore((s) => s.me);
	const signOut = useSignOut();
	if (!me) return null;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader title="我的" />
			<div className="min-h-0 flex-1 overflow-y-auto bg-sidebar">
				<div className="mx-auto flex w-full max-w-thread flex-col gap-4 px-4 py-6 md:px-6">
					<section className="flex items-center gap-4 rounded-card bg-bg p-4">
						<PersonAvatar principal={me.principal} size={72} />
						<div className="min-w-0">
							<p className="truncate text-20 font-semibold text-ink">
								{me.principal.displayName}
							</p>
							<p className="truncate text-13 text-muted">
								{me.tenant.name} · @{me.principal.handle}
							</p>
						</div>
					</section>
					<section className="divide-y divide-line overflow-hidden rounded-card bg-bg">
						<Row href="/agents" icon={<IconAgents />}>
							代理组
						</Row>
						<Row href="/devices" icon={<IconDevice />}>
							设备
						</Row>
					</section>
					<section className="rounded-card bg-bg p-4">
						<p className="mb-2 text-14 font-semibold text-ink">主题</p>
						<ThemeSegmented />
					</section>
					{signOut ? (
						<button
							type="button"
							onClick={() => void signOut()}
							className="flex h-12 items-center justify-center gap-2 rounded-card bg-bg text-14 font-medium text-danger transition-colors duration-150 hover:bg-surface-2"
						>
							<IconLogout size={18} />
							退出登录
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}
