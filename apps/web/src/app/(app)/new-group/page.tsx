"use client";

import { GROUP_TITLE_MAX_LENGTH, type Principal } from "@orgos/protocol";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { IconCheck } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/states";
import { appHref } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";
import { createGroup, useStore } from "@/lib/store";

type Option = { principal: Principal; note: string };

function OptionRow({
	option,
	checked,
	onToggle,
}: {
	option: Option;
	checked: boolean;
	onToggle: () => void;
}) {
	const p = option.principal;
	return (
		<li>
			<label className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-surface-2">
				<input
					type="checkbox"
					className="peer sr-only"
					checked={checked}
					onChange={onToggle}
				/>
				<span
					aria-hidden="true"
					className={cx(
						"inline-flex size-5 shrink-0 items-center justify-center rounded-capsule border peer-focus-visible:ring-2 peer-focus-visible:ring-accent",
						checked
							? "border-ink bg-ink text-surface"
							: "border-line text-transparent",
					)}
				>
					<IconCheck size={14} />
				</span>
				<Avatar principal={p} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-14 text-ink">{p.displayName}</span>
					<span className="truncate font-code text-12 text-muted">
						@{p.handle}
					</span>
				</span>
				<span className="shrink-0 text-12 text-muted">{option.note}</span>
			</label>
		</li>
	);
}

/** 新建群聊：群名 + 从同事、同事的幕僚长、我的代理里勾选成员。 */
export default function NewGroupPage() {
	const router = useRouter();
	const me = useStore((s) => s.me);
	const directory = useStore((s) => s.directory);
	const [title, setTitle] = useState("");
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!me) return null;

	const colleagues = directory.filter(
		(p) => p.principal.id !== me.principal.id,
	);
	const sections: { title: string; options: Option[] }[] = [
		{
			title: "我的代理组",
			options: me.agents.map((a) => ({
				principal: a.principal,
				note: a.role === "front" ? "幕僚长" : "专员",
			})),
		},
		{
			title: "同事",
			options: colleagues.map((p) => ({ principal: p.principal, note: "人" })),
		},
		{
			title: "同事的幕僚长",
			options: colleagues.map((p) => ({
				principal: p.front,
				note: `代${p.principal.displayName}`,
			})),
		},
	];

	const toggle = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!title.trim()) {
			setError("给群起个名字");
			return;
		}
		if (selected.size === 0) {
			setError("至少选一位成员");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const id = await createGroup(title.trim(), [...selected]);
			router.push(appHref(`/c/${id}`));
		} catch (err) {
			setError(err instanceof Error ? err.message : "建群失败");
			setBusy(false);
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader title="新建群聊" />
			<form
				onSubmit={submit}
				className="flex min-h-0 flex-1 flex-col"
				noValidate
			>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="max-w-thread px-4 py-6 md:px-6">
						<Field
							label="群名"
							placeholder="例如：Q4 发布"
							maxLength={GROUP_TITLE_MAX_LENGTH}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							autoFocus
						/>
						{sections.map((section) => (
							<section key={section.title} className="mt-6">
								<h2 className="text-12 font-medium text-muted">
									{section.title}
								</h2>
								{section.options.length === 0 ? (
									<div className="mt-2 rounded-box border border-line bg-surface">
										<EmptyState
											compact
											text="组织里还没有其他同事。"
											action={{
												label: "打开通讯录",
												href: appHref("/contacts"),
											}}
										/>
									</div>
								) : (
									<ul className="mt-2 divide-y divide-line overflow-hidden rounded-box border border-line bg-surface">
										{section.options.map((o) => (
											<OptionRow
												key={o.principal.id}
												option={o}
												checked={selected.has(o.principal.id)}
												onToggle={() => toggle(o.principal.id)}
											/>
										))}
									</ul>
								)}
							</section>
						))}
					</div>
				</div>
				<footer className="flex shrink-0 items-center gap-3 border-t border-line bg-surface px-4 py-3 md:px-6">
					<span className="font-code text-12 tabular-nums text-muted">
						已选 {selected.size}
					</span>
					{error ? (
						<span role="alert" className="min-w-0 truncate text-13 text-danger">
							{error}
						</span>
					) : null}
					<Button
						type="submit"
						variant="primary"
						disabled={busy}
						className="ml-auto"
					>
						{busy ? "创建中…" : "创建群聊"}
					</Button>
				</footer>
			</form>
		</div>
	);
}
