"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
	IconAgents,
	IconChat,
	IconContacts,
	IconDevice,
	IconLogout,
	IconMe,
	IconTodo,
} from "@/components/icons";
import { Mascot } from "@/components/mascot";
import { ThemeSegmented } from "@/components/theme";
import { PersonAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { MenuItem, Popover } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { appHref, bearerToken } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";
import { resetSession, useStore } from "@/lib/store";

export type NavKey =
	| "chats"
	| "todo"
	| "contacts"
	| "agents"
	| "devices"
	| "me";

export function navKeyOf(pathname: string): NavKey {
	for (const key of ["todo", "contacts", "agents", "devices", "me"] as const)
		if (pathname === `/${key}` || pathname.startsWith(`/${key}/`)) return key;
	return "chats";
}

type NavItem = {
	key: NavKey;
	label: string;
	href: string;
	Icon: typeof IconChat;
};

/** 导航轨（≥768）：消息 / 待办 / 通讯录 / 代理组 / 设备。 */
const RAIL_ITEMS: NavItem[] = [
	{ key: "chats", label: "消息", href: "/", Icon: IconChat },
	{ key: "todo", label: "待办", href: "/todo", Icon: IconTodo },
	{ key: "contacts", label: "通讯录", href: "/contacts", Icon: IconContacts },
	{ key: "agents", label: "代理组", href: "/agents", Icon: IconAgents },
	{ key: "devices", label: "设备", href: "/devices", Icon: IconDevice },
];

/** 底部标签栏（<768）：消息 / 待办 / 通讯录 / 我的。 */
const TAB_ITEMS: NavItem[] = [
	{ key: "chats", label: "消息", href: "/", Icon: IconChat },
	{ key: "todo", label: "待办", href: "/todo", Icon: IconTodo },
	{ key: "contacts", label: "通讯录", href: "/contacts", Icon: IconContacts },
	{ key: "me", label: "我的", href: "/me", Icon: IconMe },
];

function useCounts(): Partial<Record<NavKey, number>> {
	const unread = useStore((s) =>
		s.conversations.reduce((n, x) => n + x.unread, 0),
	);
	const todo = useStore((s) => s.workItems?.length ?? 0);
	return { chats: unread, todo };
}

function CountBadge({ k, count }: { k: NavKey; count: number | undefined }) {
	if (!count) return null;
	return (
		<Badge
			count={count}
			tone={k === "todo" ? "pending" : "unread"}
			label={k === "todo" ? `${count} 条待办` : `${count} 条未读`}
			className="absolute -top-1 left-1/2 ml-1.5"
		/>
	);
}

/** 退出登录；bearer 模式（模拟台窗格）下没有这个动作，返回 null。 */
export function useSignOut(): (() => Promise<void>) | null {
	const router = useRouter();
	if (bearerToken()) return null;
	return async () => {
		await api.signOut().catch(() => {});
		resetSession();
		router.replace("/login");
	};
}

/** 本人头像菜单：身份、主题、退出。 */
function AccountMenu() {
	const me = useStore((s) => s.me);
	const signOut = useSignOut();
	const [open, setOpen] = useState(false);
	if (!me) return null;
	return (
		<Popover
			open={open}
			onClose={() => setOpen(false)}
			panelClassName="bottom-0 left-full ml-2 w-64"
			trigger={
				<button
					type="button"
					aria-label="我的账号"
					aria-expanded={open}
					onClick={() => setOpen((v) => !v)}
					className="rounded-pill transition-opacity duration-150 hover:opacity-85"
				>
					<PersonAvatar principal={me.principal} size={36} />
				</button>
			}
		>
			<div className="flex items-center gap-3 px-3 pt-2 pb-3">
				<PersonAvatar principal={me.principal} size={40} />
				<span className="flex min-w-0 flex-col">
					<span className="truncate text-14 font-semibold text-ink">
						{me.principal.displayName}
					</span>
					<span className="truncate text-12 text-muted">{me.tenant.name}</span>
				</span>
			</div>
			<div className="border-t border-line px-3 py-3">
				<p className="mb-2 text-12 text-muted">主题</p>
				<ThemeSegmented />
			</div>
			{signOut ? (
				<div className="border-t border-line pt-1">
					<MenuItem tone="danger" onClick={() => void signOut()}>
						<IconLogout size={18} />
						退出登录
					</MenuItem>
				</div>
			) : null}
		</Popover>
	);
}

/** ≥768 的导航轨（64px）：图标 + 文字，底部是本人头像菜单。 */
export function NavRail({ className }: { className?: string }) {
	const pathname = usePathname();
	const active = navKeyOf(pathname);
	const counts = useCounts();
	return (
		<nav
			aria-label="主导航"
			className={cx(
				"w-rail shrink-0 flex-col items-center gap-1 bg-sidebar py-3",
				className,
			)}
		>
			<span className="mb-3" title="orgos">
				<Mascot id="orgos" size={32} label="orgos" />
			</span>
			{RAIL_ITEMS.map(({ key, label, href, Icon }) => (
				<Link
					key={key}
					href={appHref(href)}
					aria-current={active === key ? "page" : undefined}
					className={cx(
						"relative flex w-14 flex-col items-center gap-1 rounded-card py-2 transition-colors duration-150",
						active === key
							? "bg-accent-soft text-accent"
							: "text-muted hover:bg-surface-2 hover:text-ink",
					)}
				>
					<Icon size={20} />
					<span className="text-11 font-medium">{label}</span>
					<CountBadge k={key} count={counts[key]} />
				</Link>
			))}
			<div className="mt-auto">
				<AccountMenu />
			</div>
		</nav>
	);
}

/** <768 的底部标签栏。 */
export function BottomTabs({ className }: { className?: string }) {
	const pathname = usePathname();
	const key = navKeyOf(pathname);
	// 代理组与设备在手机上从"我的"进入。
	const active = key === "agents" || key === "devices" ? "me" : key;
	const counts = useCounts();
	return (
		<nav
			aria-label="主导航"
			className={cx(
				"flex shrink-0 border-t border-line bg-sidebar pb-[env(safe-area-inset-bottom)]",
				className,
			)}
		>
			{TAB_ITEMS.map(({ key, label, href, Icon }) => (
				<Link
					key={key}
					href={appHref(href)}
					aria-current={active === key ? "page" : undefined}
					className={cx(
						"relative flex h-tabbar flex-1 flex-col items-center justify-center gap-0.5 transition-colors duration-150",
						active === key ? "text-accent" : "text-muted",
					)}
				>
					<Icon size={22} />
					<span className="text-11 font-medium">{label}</span>
					<CountBadge k={key} count={counts[key]} />
				</Link>
			))}
		</nav>
	);
}
