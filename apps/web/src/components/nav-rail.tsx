"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { IconChat, IconContacts, IconLogout } from "@/components/icons";
import { ThemeToggle } from "@/components/theme";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/button";
import { api } from "@/lib/api";
import { appHref, bearerToken } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";
import { resetSession, useStore } from "@/lib/store";

export type NavKey = "chats" | "contacts";

export function navKeyOf(pathname: string): NavKey {
	return pathname.startsWith("/contacts") ? "contacts" : "chats";
}

export const NAV_ITEMS = [
	{ key: "chats", label: "会话", href: "/", Icon: IconChat },
	{ key: "contacts", label: "通讯录", href: "/contacts", Icon: IconContacts },
] as const;

export function useTotalUnread(): number {
	return useStore((s) => s.conversations.reduce((n, x) => n + x.unread, 0));
}

/** 退出登录；bearer 模式（模拟台窗格）不显示。 */
export function LogoutButton() {
	const router = useRouter();
	if (bearerToken()) return null;
	return (
		<IconButton
			label="退出登录"
			onClick={async () => {
				await api.signOut().catch(() => {});
				resetSession();
				router.replace("/login");
			}}
		>
			<IconLogout />
		</IconButton>
	);
}

/** ≥1024 的独立导航轨（64px）。 */
export function NavRail({ className }: { className?: string }) {
	const pathname = usePathname();
	const active = navKeyOf(pathname);
	const me = useStore((s) => s.me);
	const unread = useTotalUnread();
	return (
		<nav
			aria-label="主导航"
			className={cx(
				"w-rail shrink-0 flex-col items-center gap-2 border-r border-line bg-surface py-4",
				className,
			)}
		>
			<span className="mb-2 font-code text-12 text-muted">orgos</span>
			{NAV_ITEMS.map(({ key, label, href, Icon }) => (
				<Link
					key={key}
					href={appHref(href)}
					aria-label={label}
					title={label}
					aria-current={active === key ? "page" : undefined}
					className={cx(
						"relative inline-flex size-10 items-center justify-center rounded-capsule transition-colors duration-150",
						active === key
							? "bg-accent-soft text-accent"
							: "text-muted hover:bg-surface-2 hover:text-ink",
					)}
				>
					<Icon />
					{key === "chats" ? (
						<Badge count={unread} className="absolute -top-1 -right-1" />
					) : null}
				</Link>
			))}
			<div className="mt-auto flex flex-col items-center gap-2">
				<ThemeToggle />
				<LogoutButton />
				{me ? (
					<span title={`${me.principal.displayName} @${me.principal.handle}`}>
						<Avatar principal={me.principal} />
					</span>
				) : null}
			</div>
		</nav>
	);
}

/** <1024：导航并入列表栏顶部的一行分段切换。 */
export function NavTabs() {
	const pathname = usePathname();
	const active = navKeyOf(pathname);
	const unread = useTotalUnread();
	return (
		<nav
			aria-label="主导航"
			className="flex items-center gap-1 rounded-capsule bg-surface-2 p-1"
		>
			{NAV_ITEMS.map(({ key, label, href }) => (
				<Link
					key={key}
					href={appHref(href)}
					aria-current={active === key ? "page" : undefined}
					className={cx(
						"inline-flex h-8 items-center gap-2 rounded-capsule px-3 text-13 font-medium transition-colors duration-150",
						active === key
							? "bg-accent-soft text-accent"
							: "text-muted hover:text-ink",
					)}
				>
					{label}
					{key === "chats" ? <Badge count={unread} /> : null}
				</Link>
			))}
		</nav>
	);
}
