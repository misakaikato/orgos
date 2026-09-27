"use client";

import type { Principal } from "@orgos/protocol";
import { type ReactNode, useState } from "react";
import { Mascot } from "@/components/mascot";
import { PageHeader } from "@/components/page-header";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { useOpenDm } from "@/lib/hooks";
import { useStore } from "@/lib/store";

function Section({
	title,
	count,
	children,
}: {
	title: string;
	count?: number;
	children: ReactNode;
}) {
	return (
		<section className="mt-6 first:mt-0">
			<h2 className="px-1 text-14 font-semibold text-ink">
				{title}
				{count !== undefined ? (
					<span className="ml-1.5 font-normal text-muted">{count}</span>
				) : null}
			</h2>
			<div className="mt-2 overflow-hidden rounded-card border border-line bg-bg">
				{children}
			</div>
		</section>
	);
}

function Identity({ p, note }: { p: Principal; note: string }) {
	return (
		<span className="flex min-w-0 flex-1 items-center gap-3">
			<Avatar principal={p} size={40} />
			<span className="flex min-w-0 flex-col">
				<span className="truncate text-14 font-semibold text-ink">
					{p.displayName}
				</span>
				<span className="truncate text-12 text-muted">{note}</span>
			</span>
		</span>
	);
}

/** 通讯录：我的代理组、本组织的同事及其幕僚长；可发私聊，或去找对方的幕僚长。 */
export default function ContactsPage() {
	const me = useStore((s) => s.me);
	const directory = useStore((s) => s.directory);
	const { open, pendingId, error } = useOpenDm();
	const [copied, setCopied] = useState(false);
	if (!me) return null;

	const meId = me.principal.id;
	const others = directory.filter((p) => p.principal.id !== meId);
	const inviteCode = me.tenant.inviteCode;
	const chief = me.agents.find((a) => a.role === "front");
	const busy = (id: string) => pendingId === id;
	const copy = () => {
		if (!inviteCode) return;
		void navigator.clipboard
			?.writeText(inviteCode)
			.then(() => setCopied(true))
			.catch(() => {});
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader title="通讯录" subtitle={me.tenant.name} />
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-thread px-4 py-6 md:px-6">
					{error ? (
						<p role="alert" className="mb-4 text-13 text-danger">
							{error}
						</p>
					) : null}

					<Section title="我的代理组" count={me.agents.length}>
						<ul className="divide-y divide-line">
							{me.agents.map((a) => (
								<li
									key={a.principal.id}
									className="flex items-center gap-3 px-4 py-3"
								>
									<Identity
										p={a.principal}
										note={
											a.role === "front"
												? "幕僚长 · 对外代表你"
												: "专员 · 只替你办事"
										}
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
					</Section>

					<Section title="同事" count={others.length}>
						{others.length === 0 ? (
							inviteCode ? (
								<EmptyState
									mascotId="contacts-empty"
									text={`组织里还只有你。把邀请码 ${inviteCode} 发给同事，他们注册后就能加入。`}
									action={{
										label: copied ? "已复制" : "复制邀请码",
										onClick: copy,
									}}
								/>
							) : (
								<EmptyState
									mascotId="contacts-empty"
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
							)
						) : (
							<ul className="divide-y divide-line">
								{others.map(({ principal, front }) => (
									<li
										key={principal.id}
										className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
									>
										<Identity p={principal} note={`@${principal.handle}`} />
										<span className="flex shrink-0 items-center gap-2 pl-[52px] sm:pl-0">
											<Button
												disabled={busy(principal.id)}
												onClick={() => void open(principal.id)}
											>
												{busy(principal.id) ? "打开中…" : "发消息"}
											</Button>
											<Button
												title={front.displayName}
												disabled={busy(front.id)}
												onClick={() => void open(front.id)}
												className="pl-1.5"
											>
												<Mascot id={front.id} size={24} />
												{busy(front.id) ? "打开中…" : "找其幕僚长"}
											</Button>
										</span>
									</li>
								))}
							</ul>
						)}
					</Section>

					{inviteCode && others.length > 0 ? (
						<p className="mt-4 flex flex-wrap items-center gap-2 px-1 text-13 text-muted">
							邀请码
							<span className="font-semibold tracking-wide text-ink">
								{inviteCode}
							</span>
							<button
								type="button"
								onClick={copy}
								className="text-accent hover:underline"
							>
								{copied ? "已复制" : "复制"}
							</button>
							同事注册后可凭它加入。
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
