"use client";

import type { Runner } from "@orgos/protocol";
import { useState } from "react";
import { IconDevice } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cx } from "@/lib/cx";
import { formatListTime } from "@/lib/format";
import { revokeRunner } from "@/lib/store";

function presence(runner: Runner): string {
	if (runner.status === "online") return "在线";
	return runner.lastSeenAt
		? `离线 · 最后在线 ${formatListTime(runner.lastSeenAt)}`
		: "离线 · 还没连上过";
}

/** 设备列表的一行：名称、系统、工作目录、在线状态点与最后在线；吊销要二次确认。 */
export function RunnerRow({
	runner,
	boundTo,
}: {
	runner: Runner;
	/** 绑定了这台设备的代理名。 */
	boundTo: string[];
}) {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const online = runner.status === "online";

	const revoke = async () => {
		setBusy(true);
		setError(null);
		try {
			await revokeRunner(runner.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : "吊销失败");
			setBusy(false);
		}
	};

	return (
		<li className="flex gap-3 rounded-card border border-line bg-bg p-4">
			<span className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink">
				<IconDevice />
				<span
					aria-hidden="true"
					className={cx(
						"absolute right-0 bottom-0 size-2.5 rounded-pill ring-2 ring-bg",
						online ? "bg-good" : "bg-muted",
					)}
				/>
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-baseline gap-x-2">
					<h2 className="truncate text-14 font-semibold text-ink">
						{runner.name}
					</h2>
					<span className="text-12 text-muted">{runner.os}</span>
				</div>
				<p className="text-12 text-muted">{presence(runner)}</p>
				{runner.workspace ? (
					<p
						className="mt-1 truncate text-13 text-ink"
						title={runner.workspace}
					>
						工作目录 {runner.workspace}
					</p>
				) : null}
				<p className="mt-1 text-13 text-muted">
					{boundTo.length > 0
						? `${boundTo.join("、")}在用这台设备`
						: "还没有代理绑定这台设备"}
				</p>
				{error ? (
					<p role="alert" className="mt-2 text-12 text-danger">
						{error}
					</p>
				) : null}
				<div className="mt-3 flex flex-wrap items-center gap-2">
					{confirming ? (
						<>
							<span className="text-13 text-ink">
								吊销后这台设备立即断开，需要重新配对才能再用。
							</span>
							<Button variant="danger" disabled={busy} onClick={revoke}>
								{busy ? "吊销中…" : "确认吊销"}
							</Button>
							<Button disabled={busy} onClick={() => setConfirming(false)}>
								取消
							</Button>
						</>
					) : (
						<Button variant="danger" onClick={() => setConfirming(true)}>
							吊销
						</Button>
					)}
				</div>
			</div>
		</li>
	);
}
