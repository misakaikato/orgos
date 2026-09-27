"use client";

import type { MemorySourceLink, MessageCitation } from "@orgos/protocol";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconChevronRight } from "@/components/icons";
import { useDismiss } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { appHref } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";

const CHIP_CHARS = 14;

/** 条目出处里我看得到的原消息（同一条目只问一次服务端）。 */
const sourceCache = new Map<string, Promise<MemorySourceLink[]>>();

function sourcesOf(id: string): Promise<MemorySourceLink[]> {
	let p = sourceCache.get(id);
	if (!p) {
		p = api
			.memorySources(id)
			.then((r) => r.links)
			.catch(() => []);
		sourceCache.set(id, p);
	}
	return p;
}

/** 原消息的站内地址：会话 + 话题，锚点定位到那条消息。 */
export function messageHref(link: MemorySourceLink): string {
	return appHref(`/c/${link.conversationId}?t=${link.topicId}#m${link.seq}`);
}

function clip(text: string): string {
	const chars = Array.from(text);
	return chars.length > CHIP_CHARS
		? `${chars.slice(0, CHIP_CHARS).join("")}…`
		: text;
}

function SourceLinks({ id }: { id: string }) {
	const router = useRouter();
	const [links, setLinks] = useState<MemorySourceLink[] | null>(null);
	useEffect(() => {
		let alive = true;
		void sourcesOf(id).then((l) => {
			if (alive) setLinks(l);
		});
		return () => {
			alive = false;
		};
	}, [id]);
	if (links === null)
		return <p className="mt-2 text-12 text-muted">正在查找原消息…</p>;
	if (links.length === 0) return null;
	return (
		<div className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
			{links.map((l) => (
				<button
					key={`${l.conversationId}-${l.seq}`}
					type="button"
					onClick={() => router.push(messageHref(l))}
					className="inline-flex items-center gap-1 self-start rounded-pill text-12 font-medium text-accent hover:underline"
				>
					查看原消息 · {l.label}
					<IconChevronRight size={14} />
				</button>
			))}
		</div>
	);
}

function CitationChip({
	citation,
	index,
}: {
	citation: MessageCitation;
	index: number;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const close = useCallback(() => setOpen(false), []);
	useDismiss(ref, open, close);
	const hold = (next: boolean) => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setOpen(next), next ? 150 : 200);
	};
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 悬停意图覆盖标签与其浮层两处，只是显示提示；键盘与触摸经内部按钮开合。
		<div
			ref={ref}
			className="relative"
			onMouseEnter={() => hold(true)}
			onMouseLeave={() => hold(false)}
		>
			<button
				type="button"
				aria-expanded={open}
				aria-label={`依据 ${index + 1}：${citation.content}`}
				onClick={() => setOpen((v) => !v)}
				className={cx(
					"inline-flex h-6 max-w-56 items-center gap-1 rounded-pill px-2 text-12 transition-colors duration-150",
					open
						? "bg-accent-soft text-ink"
						: "bg-surface-2 text-muted hover:text-ink",
				)}
			>
				<span className="font-medium">依据</span>
				<span className="truncate">{clip(citation.content)}</span>
			</button>
			{open ? (
				<div
					role="tooltip"
					className="absolute top-full left-0 z-30 mt-1 w-72 max-w-[80vw] animate-pop-in rounded-card bg-bg p-3 shadow-float"
				>
					<p className="text-12 text-muted">分身回答时用到的记忆</p>
					<p className="mt-1 text-13 break-words text-ink">
						{citation.content}
					</p>
					<SourceLinks id={citation.id} />
				</div>
			) : null}
		</div>
	);
}

/**
 * 代理消息下的"依据"小标签：悬停（或点按）显示条目内容；看得到原始出处的人可以跳到原消息。
 * 内容是回答时给出的样子（替他人回答时已按第三人规则处理）。
 */
export function Citations({
	citations,
}: {
	citations: readonly MessageCitation[] | undefined;
}) {
	if (!citations || citations.length === 0) return null;
	return (
		<div className="mt-1 flex max-w-full flex-wrap gap-1">
			{citations.map((c, i) => (
				<CitationChip key={c.id} citation={c} index={i} />
			))}
		</div>
	);
}
