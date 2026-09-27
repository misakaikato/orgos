"use client";

import {
	AGENT_ROLE_LABEL,
	isExternalAgent,
	type MeResponse,
	type Principal,
} from "@orgos/protocol";
import { IconCheck } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/states";
import { appHref } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";
import type { Person } from "@/lib/store";

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
			<label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-surface-2">
				<input
					type="checkbox"
					className="peer sr-only"
					checked={checked}
					onChange={onToggle}
				/>
				<span
					aria-hidden="true"
					className={cx(
						"inline-flex size-5 shrink-0 items-center justify-center rounded-pill border-2 transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-accent",
						checked
							? "border-accent bg-accent text-on-accent"
							: "border-line text-transparent",
					)}
				>
					<IconCheck size={14} />
				</span>
				<Avatar principal={p} size={36} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-14 font-medium text-ink">
						{p.displayName}
					</span>
					<span className="truncate text-12 text-muted">@{p.handle}</span>
				</span>
				<span className="shrink-0 text-12 text-muted">{option.note}</span>
			</label>
		</li>
	);
}

/**
 * 拉人进群的勾选列表：同事（各自的分身随本人入群，不单独列出）与我自己的内置助手
 * （我的分身随我入群；外部助手只在与我的私聊里接活）。
 */
export function MemberPicker({
	me,
	directory,
	selected,
	onToggle,
	exclude,
}: {
	me: MeResponse;
	directory: readonly Person[];
	selected: ReadonlySet<string>;
	onToggle: (id: string) => void;
	/** 已在群里、不再列出的主体。 */
	exclude?: ReadonlySet<string>;
}) {
	const skip = exclude ?? new Set<string>();
	const sections: { title: string; options: Option[] }[] = [
		{
			title: "同事",
			options: directory
				.filter(
					(p) =>
						p.principal.id !== me.principal.id && !skip.has(p.principal.id),
				)
				.map((p) => ({ principal: p.principal, note: "分身随本人入群" })),
		},
		{
			title: "我的助手",
			options: me.agents
				.filter(
					(a) =>
						a.role !== "front" &&
						!isExternalAgent(a) &&
						!skip.has(a.principal.id),
				)
				.map((a) => ({
					principal: a.principal,
					note: AGENT_ROLE_LABEL[a.role],
				})),
		},
	];
	return (
		<>
			{sections.map((section) => (
				<section key={section.title} className="mt-6">
					<h2 className="px-1 text-14 font-semibold text-ink">
						{section.title}
					</h2>
					{section.options.length === 0 ? (
						<div className="mt-2 rounded-card border border-line bg-bg">
							<EmptyState
								compact
								mascotId="member-picker-empty"
								text={
									section.title === "同事"
										? "没有可以再拉进来的同事。"
										: "没有可以拉进群的助手。"
								}
								action={
									section.title === "同事"
										? { label: "打开通讯录", href: appHref("/contacts") }
										: undefined
								}
							/>
						</div>
					) : (
						<ul className="mt-2 divide-y divide-line overflow-hidden rounded-card border border-line bg-bg">
							{section.options.map((o) => (
								<OptionRow
									key={o.principal.id}
									option={o}
									checked={selected.has(o.principal.id)}
									onToggle={() => onToggle(o.principal.id)}
								/>
							))}
						</ul>
					)}
				</section>
			))}
		</>
	);
}
