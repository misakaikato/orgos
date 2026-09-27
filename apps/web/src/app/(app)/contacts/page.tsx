"use client";

import {
	AGENT_ROLE_DUTY,
	AGENT_ROLE_LABEL,
	type Principal,
} from "@orgos/protocol";
import { type ReactNode, useState } from "react";
import { OrgTree } from "@/components/org/org-tree";
import { PageHeader } from "@/components/page-header";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { useOpenDm } from "@/lib/hooks";
import { STATUS_LABEL } from "@/lib/principals";
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
			<Avatar principal={p} size={40} showStatus />
			<span className="flex min-w-0 flex-col">
				<span className="truncate text-14 font-semibold text-ink">
					{p.displayName}
				</span>
				<span className="truncate text-12 text-muted">{note}</span>
			</span>
		</span>
	);
}

/**
 * 通讯录：组织树（单元 → 成员，"问<单元名>"打开与单元分身的私聊）、我的代理组、本组织的同事。
 * 和同事的私聊里自动带着双方的分身，想让对方的分身回答就在私聊里切到"问分身"。
 */
export default function ContactsPage() {
	const me = useStore((s) => s.me);
	const directory = useStore((s) => s.directory);
	const org = useStore((s) => s.org);
	const { open, pendingId, error } = useOpenDm();
	const [copied, setCopied] = useState(false);
	if (!me) return null;

	const meId = me.principal.id;
	const others = directory.filter((p) => p.principal.id !== meId);
	const inviteCode = me.tenant.inviteCode;
	const twin = me.agents.find((a) => a.role === "front");
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

					{org.length > 0 ? (
						<Section title="组织" count={org.length}>
							<OrgTree
								units={org}
								meId={meId}
								pendingId={pendingId}
								onAsk={(twinId) => void open(twinId)}
							/>
						</Section>
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
										note={`${AGENT_ROLE_LABEL[a.role]} · ${AGENT_ROLE_DUTY[a.role]}`}
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
										twin
											? {
													label: `先和${twin.principal.displayName}聊聊`,
													onClick: () => void open(twin.principal.id),
												}
											: undefined
									}
								/>
							)
						) : (
							<ul className="divide-y divide-line">
								{others.map(({ principal }) => (
									<li
										key={principal.id}
										className="flex items-center gap-3 px-4 py-3"
									>
										<Identity
											p={principal}
											note={
												principal.status && principal.status !== "available"
													? `@${principal.handle} · ${STATUS_LABEL[principal.status]}，分身会先回复`
													: `@${principal.handle}`
											}
										/>
										<Button
											disabled={busy(principal.id)}
											onClick={() => void open(principal.id)}
										>
											{busy(principal.id) ? "打开中…" : "发消息"}
										</Button>
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
