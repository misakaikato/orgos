"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { appHref } from "@/lib/auth-mode";
import { buildPrincipalMap, type PrincipalMap } from "@/lib/principals";
import { openDm, useStore } from "@/lib/store";

/** 已知主体的查找表（本人、通讯录、组织结构、会话成员）。 */
export function usePrincipalMap(): PrincipalMap {
	const me = useStore((s) => s.me);
	const directory = useStore((s) => s.directory);
	const conversations = useStore((s) => s.conversations);
	const org = useStore((s) => s.org);
	return useMemo(
		() => buildPrincipalMap(me, directory, conversations, org),
		[me, directory, conversations, org],
	);
}

/** 我的外部助手（经 ACP 接入）的 id：界面在它们的团子旁标"外部"。 */
export function useExternalAgentIds(): ReadonlySet<string> {
	const agents = useStore((s) => s.me?.agents);
	return useMemo(
		() =>
			new Set(
				(agents ?? [])
					.filter((a) => a.engine === "acp")
					.map((a) => a.principal.id),
			),
		[agents],
	);
}

/** 与某主体开私聊（已有则复用）并跳转过去。 */
export function useOpenDm(): {
	open: (principalId: string) => Promise<void>;
	pendingId: string | null;
	error: string | null;
} {
	const router = useRouter();
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const open = useCallback(
		async (principalId: string) => {
			setPendingId(principalId);
			setError(null);
			try {
				const id = await openDm(principalId);
				router.push(appHref(`/c/${id}`));
			} catch (e) {
				setError(e instanceof Error ? e.message : "打开会话失败");
			} finally {
				setPendingId(null);
			}
		},
		[router],
	);
	return { open, pendingId, error };
}

/** 订阅媒体查询；服务端渲染时为 false。 */
export function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(cb) => {
			const mql = window.matchMedia(query);
			mql.addEventListener("change", cb);
			return () => mql.removeEventListener("change", cb);
		},
		() => window.matchMedia(query).matches,
		() => false,
	);
}
