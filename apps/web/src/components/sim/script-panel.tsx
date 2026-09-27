"use client";

import type { DemoPerson } from "@orgos/protocol";
import { useEffect, useRef, useState } from "react";
import { IconCheck, IconClose } from "@/components/icons";
import { IconButton } from "@/components/ui/button";
import { cx } from "@/lib/cx";
import { type Scene, type ScriptStep, SIM_SCRIPT } from "@/lib/sim-script";

function CopyLine({
	text,
	hint,
	command,
}: {
	text: string;
	hint?: string;
	/** 指令或终端命令：用等宽体（DESIGN.md §3 允许的场景）。 */
	command?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	return (
		<div className="mt-2 flex items-start gap-2 rounded-row bg-surface-2 px-3 py-2">
			<span className="min-w-0 flex-1">
				{hint ? <span className="block text-12 text-muted">{hint}</span> : null}
				<span
					className={cx(
						"block break-words text-ink [overflow-wrap:anywhere]",
						command ? "font-code text-12" : "text-13",
					)}
				>
					{text}
				</span>
			</span>
			<button
				type="button"
				onClick={() => {
					void navigator.clipboard
						.writeText(text)
						.then(() => {
							setCopied(true);
							if (timer.current) clearTimeout(timer.current);
							timer.current = setTimeout(() => setCopied(false), 1500);
						})
						.catch(() => {});
				}}
				className="inline-flex h-6 shrink-0 items-center gap-1 rounded-pill bg-bg px-2 text-12 text-muted transition-colors duration-150 hover:text-ink"
			>
				{copied ? <IconCheck size={14} /> : null}
				{copied ? "已复制" : "复制"}
			</button>
		</div>
	);
}

function StepItem({
	step,
	index,
	nameOf,
	mockMode,
}: {
	step: ScriptStep;
	index: number;
	nameOf: (handle: string) => string;
	mockMode: boolean;
}) {
	return (
		<li className="grid grid-cols-[20px_1fr] gap-x-2">
			<span className="pt-px text-12 tabular-nums text-muted">{index + 1}</span>
			<div className="min-w-0">
				<p className="text-13 text-ink">
					<span className="font-medium">
						{step.who ? nameOf(step.who) : "终端"}
					</span>
					<span className="text-muted"> · </span>
					{step.action}
				</p>
				{step.say ? <CopyLine text={step.say} command={!step.who} /> : null}
				{step.mock && mockMode ? (
					<CopyLine text={step.mock} hint="假模型下改发" command />
				) : null}
			</div>
		</li>
	);
}

function SceneBlock({
	scene,
	nameOf,
	mockMode,
}: {
	scene: Scene;
	nameOf: (handle: string) => string;
	mockMode: boolean;
}) {
	return (
		<section className="border-b border-line px-4 py-4 last:border-b-0">
			<h3 className="flex items-center gap-2 text-14 font-medium text-ink">
				<span className="inline-flex h-5 items-center rounded-pill bg-accent-soft px-2 text-12 font-semibold text-accent">
					{scene.id}
				</span>
				{scene.title}
			</h3>
			<p className="mt-1 text-12 text-muted">{scene.summary}</p>
			<ol className="mt-3 flex flex-col gap-3">
				{scene.steps.map((step, i) => (
					<StepItem
						// biome-ignore lint/suspicious/noArrayIndexKey: 剧本是静态常量，步骤顺序即身份。
						key={i}
						step={step}
						index={i}
						nameOf={nameOf}
						mockMode={mockMode}
					/>
				))}
			</ol>
		</section>
	);
}

/** 剧本面板：C1–C4 与 R 的推荐步骤，每句话术可复制。 */
export function ScriptPanel({
	people,
	mockMode,
	onClose,
	className,
}: {
	people: readonly DemoPerson[];
	mockMode: boolean;
	onClose: () => void;
	className?: string;
}) {
	const names = new Map(people.map((p) => [p.handle, p.displayName]));
	const nameOf = (handle: string) => names.get(handle) ?? handle;
	return (
		<aside
			aria-label="剧本"
			className={cx("flex min-h-0 flex-col bg-bg", className)}
		>
			<header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
				<h2 className="flex-1 text-16 font-semibold text-ink">剧本</h2>
				<IconButton label="收起剧本" onClick={onClose}>
					<IconClose />
				</IconButton>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{SIM_SCRIPT.map((scene) => (
					<SceneBlock
						key={scene.id}
						scene={scene}
						nameOf={nameOf}
						mockMode={mockMode}
					/>
				))}
			</div>
		</aside>
	);
}
