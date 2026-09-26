"use client";

import type { Principal } from "@orgos/protocol";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { useOpenDm } from "@/lib/hooks";
import { useStore } from "@/lib/store";

function Identity({ p, note }: { p: Principal; note?: string }) {
	return (
		<span className="flex min-w-0 flex-1 items-center gap-3">
			<Avatar principal={p} size="lg" />
			<span className="flex min-w-0 flex-col">
				<span className="truncate text-14 font-medium text-ink">
					{p.displayName}
					{note ? (
						<span className="ml-2 text-12 font-normal text-muted">{note}</span>
					) : null}
				</span>
				<span className="truncate font-code text-12 text-muted">
					@{p.handle}
				</span>
			</span>
		</span>
	);
}

/** 通讯录：本租户的人及其幕僚长；可发私聊，或去找对方的幕僚长。 */
export default function ContactsPage() {
	const me = useStore((s) => s.me);
	const directory = useStore((s) => s.directory);
	const { open, pendingId, error } = useOpenDm();
	const [copied, setCopied] = useState(false);
	if (!me) return null;

	const others = directory.filter((p) => p.principal.id !== me.principal.id);
	const inviteCode = me.tenant.inviteCode;
	const chief = me.agents.find((a) => a.role === "front");
	const busy = (id: string) => pendingId === id;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={<span className="font-display text-18">通讯录</span>}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="max-w-thread px-4 py-6 md:px-6">
					{error ? (
						<p role="alert" className="mb-4 text-13 text-danger">
							{error}
						</p>
					) : null}

					<h2 className="text-12 font-medium text-muted">我的代理组</h2>
					<ul className="mt-2 flex flex-col divide-y divide-line rounded-box border border-line bg-surface">
						{me.agents.map((a) => (
							<li
								key={a.principal.id}
								className="flex items-center gap-3 px-4 py-3"
							>
								<Identity
									p={a.principal}
									note={a.role === "front" ? "对外代表你" : undefined}
								/>
								<Button
									disabled={busy(a.principal.id)}
									onClick={() => void open(a.principal.id)}
								>
									{busy(a.principal.id) ? "打开中…" : "对话"}
								</Button>
							</li>
						))}
					</ul>

					<h2 className="mt-8 text-12 font-medium text-muted">
						{me.tenant.name} ·{" "}
						<span className="font-code tabular-nums">{others.length}</span>{" "}
						位同事
					</h2>
					{others.length === 0 ? (
						<div className="mt-2 rounded-box border border-line bg-surface">
							{inviteCode ? (
								<EmptyState
									text={`组织里还只有你。把邀请码 ${inviteCode} 发给同事，他们注册后就能加入。`}
									action={{
										label: copied ? "已复制" : "复制邀请码",
										onClick: () => {
											void navigator.clipboard
												?.writeText(inviteCode)
												.then(() => setCopied(true));
										},
									}}
								/>
							) : (
								<EmptyState
									text="组织里还没有其他同事。"
									action={
										chief
											? {
													label: `先和${chief.principal.displayName}聊聊`,
													onClick: () => void open(chief.principal.id),
												}
											: undefined
									}
								/>
							)}
						</div>
					) : (
						<ul className="mt-2 flex flex-col divide-y divide-line rounded-box border border-line bg-surface">
							{others.map(({ principal, front }) => (
								<li
									key={principal.id}
									className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
								>
									<Identity p={principal} />
									<span className="flex shrink-0 gap-2">
										<Button
											disabled={busy(principal.id)}
											onClick={() => void open(principal.id)}
										>
											{busy(principal.id) ? "打开中…" : "发消息"}
										</Button>
										<Button
											title={`${front.displayName} @${front.handle}`}
											disabled={busy(front.id)}
											onClick={() => void open(front.id)}
										>
											{busy(front.id) ? "打开中…" : "找其幕僚长"}
										</Button>
									</span>
								</li>
							))}
						</ul>
					)}
					{inviteCode && others.length > 0 ? (
						<p className="mt-4 text-12 text-muted">
							邀请码 <span className="font-code text-ink">{inviteCode}</span>
							，同事注册后可凭它加入。
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
