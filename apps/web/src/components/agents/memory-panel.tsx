"use client";

import {
	MEMORY_KIND_LABEL,
	type MemoryCategory,
	type MemoryItem,
	type MemoryStatus,
} from "@orgos/protocol";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
	CategorySelect,
	errorText,
	SourceButton,
	scopeLabel,
} from "@/components/agents/memory-shared";
import { IconSearch } from "@/components/icons";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, TextAreaField } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { formatListTime } from "@/lib/format";
import { usePrincipalMap } from "@/lib/hooks";
import type { PrincipalMap } from "@/lib/principals";
import { useStore } from "@/lib/store";

const FILTERS: { key: MemoryStatus; label: string }[] = [
	{ key: "active", label: "在用" },
	{ key: "superseded", label: "已被取代" },
	{ key: "retracted", label: "已撤回" },
];

function EditForm({
	item,
	onSaved,
	onCancel,
}: {
	item: MemoryItem;
	onSaved: (next: MemoryItem) => void;
	onCancel: () => void;
}) {
	const [content, setContent] = useState(item.content);
	const [category, setCategory] = useState<MemoryCategory>(item.category);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const { item: next } = await api.updateMemoryItem(item.id, {
				...(content.trim() !== item.content ? { content } : {}),
				...(category !== item.category ? { category } : {}),
			});
			onSaved(next);
		} catch (err) {
			setError(errorText(err));
			setSaving(false);
		}
	};
	return (
		<form onSubmit={submit} className="flex flex-col gap-3">
			<TextAreaField
				label="内容"
				value={content}
				rows={3}
				maxLength={500}
				onChange={(e) => setContent(e.target.value)}
				hint="改过内容的记忆记为你本人的更正，分身会优先用它。"
			/>
			<CategorySelect label="类别" value={category} onChange={setCategory} />
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button
					type="submit"
					variant="primary"
					disabled={saving || !content.trim()}
				>
					{saving ? "保存中…" : "保存"}
				</Button>
				<Button onClick={onCancel} disabled={saving}>
					取消
				</Button>
			</div>
		</form>
	);
}

function ItemCard({
	item,
	map,
	meId,
	onChanged,
}: {
	item: MemoryItem;
	map: PrincipalMap;
	meId: string;
	onChanged: (next: MemoryItem) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const active = item.status === "active";

	if (editing)
		return (
			<section className="rounded-card border border-line bg-bg p-4">
				<EditForm
					item={item}
					onCancel={() => setEditing(false)}
					onSaved={(next) => {
						setEditing(false);
						onChanged(next);
					}}
				/>
			</section>
		);

	const retract = async () => {
		setBusy(true);
		setError(null);
		try {
			onChanged((await api.retractMemoryItem(item.id)).item);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="rounded-card border border-line bg-bg p-4">
			<p
				className={cx(
					"text-14 break-words",
					active ? "text-ink" : "text-muted line-through",
				)}
			>
				{item.content}
			</p>
			<div className="mt-2 flex flex-wrap items-center gap-1.5">
				<Tag>{item.category}</Tag>
				<Tag>{MEMORY_KIND_LABEL[item.kind]}</Tag>
				<Tag>{`可见：${scopeLabel(item.scope, map, meId)}`}</Tag>
				{item.ownerCorrected ? <Tag tone="good">本人更正</Tag> : null}
				<span className="text-12 text-muted">
					{formatListTime(item.validFrom)}
				</span>
			</div>
			<div className="mt-2">
				<SourceButton itemId={item.id} />
			</div>
			{error ? (
				<p role="alert" className="mt-2 text-12 text-danger">
					{error}
				</p>
			) : null}
			{active ? (
				<div className="mt-3 flex gap-2">
					<Button disabled={busy} onClick={() => setEditing(true)}>
						编辑
					</Button>
					<Button
						variant="danger"
						disabled={busy}
						onClick={() => void retract()}
					>
						撤回
					</Button>
				</div>
			) : null}
		</section>
	);
}

/** 记忆：组织里关于我的记忆条目——浏览、搜索、编辑、撤回，看出处与可见范围。 */
export function MemoryPanel() {
	const map = usePrincipalMap();
	const meId = useStore((s) => s.me?.principal.id ?? "");
	const [status, setStatus] = useState<MemoryStatus>("active");
	const [query, setQuery] = useState("");
	const [applied, setApplied] = useState("");
	const [items, setItems] = useState<MemoryItem[] | null>(null);
	const [failed, setFailed] = useState(false);

	const load = useCallback(async () => {
		setFailed(false);
		setItems(null);
		try {
			setItems(
				(
					await api.memoryItems({
						status,
						...(applied.trim() ? { q: applied.trim() } : {}),
					})
				).items,
			);
		} catch {
			setFailed(true);
		}
	}, [status, applied]);

	useEffect(() => {
		void load();
	}, [load]);

	const replace = (next: MemoryItem) =>
		setItems(
			(list) =>
				list
					?.map((i) => (i.id === next.id ? next : i))
					.filter((i) => i.status === status) ?? null,
		);

	return (
		<div className="flex flex-col gap-3">
			<p className="text-13 text-muted">
				你在各处的交流会自动沉淀成记忆，分身替你回答时据此作答。这里列出关于你的记忆：不对的可以改，不想留的可以撤回。
			</p>
			<search>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						setApplied(query);
					}}
					className="relative"
				>
					<IconSearch
						size={16}
						className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted"
					/>
					<Input
						aria-label="搜索记忆"
						placeholder="搜索记忆"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="pl-9"
					/>
				</form>
			</search>
			<div className="flex flex-wrap gap-2">
				{FILTERS.map((f) => (
					<button
						key={f.key}
						type="button"
						aria-pressed={status === f.key}
						onClick={() => setStatus(f.key)}
						className={cx(
							"inline-flex h-7 items-center rounded-pill px-3 text-13 transition-colors duration-150",
							status === f.key
								? "bg-accent-soft font-medium text-accent"
								: "bg-surface-2 text-muted hover:text-ink",
						)}
					>
						{f.label}
					</button>
				))}
			</div>
			{failed ? (
				<ErrorState text="记忆加载失败。" onRetry={load} />
			) : !items ? (
				<LoadingRows rows={3} />
			) : items.length === 0 ? (
				<EmptyState
					mascotId="orgos-memory-empty"
					text={
						applied.trim()
							? "没有找到相关的记忆。"
							: status === "active"
								? "还没有关于你的记忆。和同事、代理聊过的事，过一会儿就会沉淀到这里。"
								: "这里没有记忆。"
					}
					action={
						applied.trim()
							? {
									label: "清除搜索",
									onClick: () => {
										setQuery("");
										setApplied("");
									},
								}
							: undefined
					}
				/>
			) : (
				items.map((item) => (
					<ItemCard
						key={item.id}
						item={item}
						map={map}
						meId={meId}
						onChanged={replace}
					/>
				))
			)}
		</div>
	);
}
