"use client";

import { GROUP_TITLE_MAX_LENGTH } from "@orgos/protocol";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { MemberPicker } from "@/components/member-picker";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { appHref } from "@/lib/auth-mode";
import { createGroup, useStore } from "@/lib/store";

/** 新建群聊：群名 + 勾选同事（各自的分身随本人入群）与我的助手。 */
export default function NewGroupPage() {
	const router = useRouter();
	const me = useStore((s) => s.me);
	const directory = useStore((s) => s.directory);
	const [title, setTitle] = useState("");
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!me) return null;

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
			<PageHeader title="新建群聊" back="/" />
			<form
				onSubmit={submit}
				className="flex min-h-0 flex-1 flex-col"
				noValidate
			>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto w-full max-w-thread px-4 py-6 md:px-6">
						<Field
							label="群名"
							placeholder="例如：Q4 发布"
							maxLength={GROUP_TITLE_MAX_LENGTH}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							autoFocus
						/>
						<MemberPicker
							me={me}
							directory={directory}
							selected={selected}
							onToggle={toggle}
						/>
					</div>
				</div>
				<footer className="flex shrink-0 items-center gap-3 border-t border-line bg-bg px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-6">
					<span className="text-13 tabular-nums text-muted">
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
