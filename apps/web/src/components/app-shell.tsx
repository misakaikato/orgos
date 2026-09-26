"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { ConversationList } from "@/components/conversation-list";
import { NavRail } from "@/components/nav-rail";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { bearerToken } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";
import { startRealtime } from "@/lib/realtime";
import { loadSession, useStore } from "@/lib/store";

/**
 * 主界面骨架：导航轨 ｜ 列表栏 ｜ 主区（会话页自带检查器）。
 *
 * - ≥1024：导航轨 64px 独立一栏；<1024 并入列表栏顶部。
 * - <768：单栏。根路径显示列表，其余路径显示主区，靠前进 / 返回切换。
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
				<div className="hidden w-rail border-r border-line bg-surface lg:block" />
				<div className="w-full border-r border-line bg-surface md:w-list">
					<LoadingRows rows={6} />
				</div>
			</div>
		);
	}

	const atRoot = pathname === "/";
	return (
		<div className="flex h-dvh overflow-hidden bg-bg text-ink">
			<NavRail className="hidden lg:flex" />
			<aside
				className={cx(
					"min-h-0 w-full flex-col border-r border-line bg-surface md:w-list md:shrink-0",
					atRoot ? "flex" : "hidden md:flex",
				)}
			>
				<ConversationList />
			</aside>
			<main
				className={cx(
					"min-h-0 min-w-0 flex-1 flex-col",
					atRoot ? "hidden md:flex" : "flex",
				)}
			>
				{children}
			</main>
		</div>
	);
}
