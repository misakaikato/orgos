"use client";

import {
	DEFAULT_DISCLOSED_CATEGORIES,
	MEMORY_CATEGORIES,
	type MemoryCategory,
	type MemoryScope,
	type MemorySourceLink,
} from "@orgos/protocol";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { messageHref } from "@/components/conversation/citations";
import { IconChevronRight } from "@/components/icons";
import { selectClass } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { PrincipalMap } from "@/lib/principals";

export function errorText(e: unknown): string {
	return e instanceof Error ? e.message : "操作失败";
}

/** 可见范围的说法（给本人看）。 */
export function scopeLabel(
	scope: MemoryScope,
	map: PrincipalMap,
	meId: string,
): string {
	if (scope.kind === "tenant") return "全员可见";
	if (scope.kind === "owner") return "仅自己";
	const others = (scope.principalIds ?? [])
		.filter((id) => id !== meId)
		.map((id) => map.get(id)?.displayName ?? "同事");
	return others.length > 0 ? `你与${others.join("、")}` : "仅自己";
}

/** 下拉选择类别；`only` 给定时只列这些类别。 */
export function CategorySelect({
	value,
	onChange,
	label,
	only,
	disabled,
}: {
	value: MemoryCategory;
	onChange: (next: MemoryCategory) => void;
	label: string;
	only?: readonly MemoryCategory[];
	disabled?: boolean;
}) {
	const options = only ?? MEMORY_CATEGORIES;
	return (
		<label className="flex flex-col gap-1.5">
			<span className="text-13 font-medium text-ink">{label}</span>
			<select
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value as MemoryCategory)}
				className={selectClass}
			>
				{options.map((c) => (
					<option key={c} value={c}>
						{c}
						{DEFAULT_DISCLOSED_CATEGORIES.has(c) ? "" : "（默认不对外）"}
					</option>
				))}
			</select>
		</label>
	);
}

/** "出处"：点开后列出我看得到的原消息，点一条跳过去。 */
export function SourceButton({ itemId }: { itemId: string }) {
	const router = useRouter();
	const [links, setLinks] = useState<MemorySourceLink[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [open, setOpen] = useState(false);

	const toggle = async () => {
		if (open) {
			setOpen(false);
			return;
		}
		setOpen(true);
		if (links) return;
		setLoading(true);
		try {
			setLinks((await api.memorySources(itemId)).links);
		} catch {
			setLinks([]);
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => void toggle()}
				className="inline-flex items-center gap-1 self-start text-12 text-muted transition-colors duration-150 hover:text-ink"
			>
				出处
				<IconChevronRight
					size={14}
					className={
						open ? "rotate-90 transition-transform" : "transition-transform"
					}
				/>
			</button>
			{open ? (
				loading ? (
					<p className="text-12 text-muted">正在查找原消息…</p>
				) : links && links.length > 0 ? (
					<div className="flex flex-col gap-1">
						{links.map((l) => (
							<button
								key={`${l.conversationId}-${l.seq}`}
								type="button"
								onClick={() => router.push(messageHref(l))}
								className="inline-flex items-center gap-1 self-start text-12 font-medium text-accent hover:underline"
							>
								查看原消息 · {l.label}
								<IconChevronRight size={14} />
							</button>
						))}
					</div>
				) : (
					<p className="text-12 text-muted">来自本人更正或已无法定位的消息。</p>
				)
			) : null}
		</div>
	);
}
