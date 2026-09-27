"use client";

import type { DemoPerson, Principal } from "@orgos/protocol";
import { PersonAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { appHref } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";

export type PaneSession =
	| { status: "loading" }
	| {
			status: "ready";
			token: string;
			principal: Principal;
			/** null = 还没读到。 */
			pending: number | null;
	  }
	| { status: "error"; message: string };

/** 模拟台的一列：列头（人名、岗位、待办数）+ 以该身份登录的 iframe。 */
export function SimPane({
	person,
	session,
	onRetry,
	className,
}: {
	person: DemoPerson;
	session: PaneSession | undefined;
	onRetry: () => void;
	className?: string;
}) {
	const ready = session?.status === "ready" ? session : null;
	return (
		<section
			aria-label={`${person.displayName}的窗格`}
			className={cx(
				"flex min-h-0 min-w-0 flex-col overflow-hidden rounded-card bg-bg shadow-float",
				className,
			)}
		>
			<header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3">
				<PersonAvatar principal={person} size={28} />
				<span className="truncate text-14 font-semibold text-ink">
					{person.displayName}
				</span>
				<span className="truncate text-12 text-muted">{person.title}</span>
				<span className="ml-auto flex shrink-0 items-center gap-2">
					{ready && ready.pending !== null ? (
						ready.pending > 0 ? (
							<>
								<span className="text-12 text-muted">待办</span>
								<Badge
									count={ready.pending}
									tone="pending"
									label={`${ready.pending} 条待办`}
								/>
							</>
						) : (
							<span className="text-12 text-muted">无待办</span>
						)
					) : null}
				</span>
			</header>
			{ready ? (
				<iframe
					key={ready.token}
					title={`以${person.displayName}的身份使用 orgos`}
					src={appHref("/", ready.token)}
					className="min-h-0 w-full flex-1 border-0 bg-bg"
				/>
			) : session?.status === "error" ? (
				<div className="flex flex-1 items-center justify-center bg-bg">
					<ErrorState text={session.message} onRetry={onRetry} />
				</div>
			) : (
				<div className="flex-1 bg-bg">
					<LoadingRows rows={5} />
				</div>
			)}
		</section>
	);
}
