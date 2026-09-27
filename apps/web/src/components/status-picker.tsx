"use client";

import { PRINCIPAL_STATUSES, type PrincipalStatus } from "@orgos/protocol";
import { useState } from "react";
import { cx } from "@/lib/cx";
import { STATUS_LABEL } from "@/lib/principals";
import { setMyStatus, useStore } from "@/lib/store";

const DOT: Record<PrincipalStatus, string> = {
	available: "bg-good",
	busy: "bg-pending",
	away: "bg-muted",
};

const HINT: Record<PrincipalStatus, string> = {
	available: "同事的消息直接发给你",
	busy: "同事发来的消息先由你的分身回复",
	away: "同事发来的消息先由你的分身回复",
};

/** 本人在线状态的三段式选择（头像菜单、"我的"页）。 */
export function StatusPicker({ className }: { className?: string }) {
	const status = useStore((s) => s.me?.principal.status ?? "available");
	const [saving, setSaving] = useState<PrincipalStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const choose = async (next: PrincipalStatus) => {
		if (next === status || saving) return;
		setSaving(next);
		setError(null);
		try {
			await setMyStatus(next);
		} catch (e) {
			setError(e instanceof Error ? e.message : "切换失败");
		} finally {
			setSaving(null);
		}
	};
	return (
		<div className={className}>
			<div
				role="toolbar"
				aria-label="在线状态"
				className="flex gap-1 rounded-pill bg-surface-2 p-1"
			>
				{PRINCIPAL_STATUSES.map((s) => (
					<button
						key={s}
						type="button"
						aria-pressed={status === s}
						disabled={saving !== null}
						onClick={() => void choose(s)}
						className={cx(
							"inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-pill px-2 text-12 whitespace-nowrap transition-colors duration-150",
							status === s
								? "bg-bg font-medium text-ink shadow-card-hover"
								: "text-muted hover:text-ink",
						)}
					>
						<span
							aria-hidden="true"
							className={cx("size-2 rounded-pill", DOT[s])}
						/>
						{STATUS_LABEL[s]}
					</button>
				))}
			</div>
			<p
				role={error ? "alert" : undefined}
				className={cx("mt-2 text-12", error ? "text-danger" : "text-muted")}
			>
				{error ?? HINT[status]}
			</p>
		</div>
	);
}
