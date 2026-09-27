"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { ConversationList } from "@/components/conversation-list";
import { BottomTabs, NavRail, navKeyOf } from "@/components/nav-rail";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { bearerToken } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";
import { startRealtime } from "@/lib/realtime";
import { loadSession, useStore } from "@/lib/store";

/**
 * 主界面骨架（DESIGN.md §5、§8）：导航轨 64 ｜ 会话列表 300 ｜ 主区（会话页自带检查器）。
 *
 * - ≥768：导航轨常驻；"消息"分区显示会话列表栏，其他分区主区独占。
 * - <768：单栏 + 底部标签栏。会话列表在根路径，进入会话后隐藏标签栏、输入框贴底。
 */
export function AppShell({ children }: { children: ReactNode }) {
	const router = useRouter();
	const pathname = usePathname();
	const session = useStore((s) => s.session);
	const sessionError = useStore((s) => s.sessionError);

	useEffect(() => {
		void loadSession();
	}, []);

	useEffect(() => {
		if (session !== "ready") return;
		return startRealtime();
	}, [session]);

	useEffect(() => {
		// bearer 模式（模拟台窗格）下凭据失效不跳登录页：登录会写 cookie，串了其他窗格的身份。
		if (session === "unauthorized" && !bearerToken()) router.replace("/login");
		if (session === "not-onboarded") router.replace("/onboarding");
	}, [session, router]);

	if (session === "error") {
		return (
			<div className="flex h-dvh items-center justify-center bg-bg">
				<ErrorState
					text={`加载失败：${sessionError ?? "未知错误"}`}
					onRetry={() => void loadSession()}
				/>
			</div>
		);
	}
	if (session === "unauthorized" && bearerToken()) {
		return (
			<div className="flex h-dvh items-center justify-center bg-bg">
				<ErrorState text="这个窗格的身份凭据已失效，请回到模拟台重新选择人物。" />
			</div>
		);
	}
	if (session !== "ready") {
		return (
			<div className="flex h-dvh bg-bg">
				<div className="hidden w-rail bg-sidebar md:block" />
				<div className="w-full bg-sidebar md:w-list">
					<LoadingRows rows={6} />
				</div>
			</div>
		);
	}

	const section = navKeyOf(pathname);
	const chats = section === "chats";
	const atRoot = pathname === "/";
	const showTabs = !chats || atRoot;
	return (
		<div className="flex h-dvh overflow-hidden bg-bg text-ink">
			<NavRail className="hidden border-r border-line md:flex" />
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex min-h-0 flex-1">
					{chats ? (
						<aside
							className={cx(
								"min-h-0 w-full flex-col bg-sidebar md:w-list md:shrink-0",
								atRoot ? "flex" : "hidden md:flex",
							)}
						>
							<ConversationList />
						</aside>
					) : null}
					<main
						className={cx(
							"min-h-0 min-w-0 flex-1 flex-col bg-bg",
							chats && atRoot ? "hidden md:flex" : "flex",
						)}
					>
						{children}
					</main>
				</div>
				{showTabs ? <BottomTabs className="md:hidden" /> : null}
			</div>
		</div>
	);
}
