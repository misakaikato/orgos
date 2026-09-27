"use client";

import {
	DEFAULT_DISCLOSED_CATEGORIES,
	type DisclosureRule,
} from "@orgos/protocol";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "@/components/agents/memory-shared";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/input";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { useStore } from "@/lib/store";

function RuleRow({
	rule,
	busy,
	onToggle,
}: {
	rule: DisclosureRule;
	busy: boolean;
	onToggle: (next: boolean) => void;
}) {
	const changed = !rule.isDefault;
	return (
		<li className="flex h-11 items-center gap-3 px-4">
			<span className="min-w-0 flex-1 truncate text-14 text-ink">
				{rule.category}
			</span>
			{changed ? <Tag>已改动</Tag> : null}
			<span className={cx("text-12", rule.allowed ? "text-ink" : "text-muted")}>
				{rule.allowed ? "可对外" : "不对外"}
			</span>
			<Switch
				checked={rule.allowed}
				disabled={busy}
				label={`${rule.category}：${rule.allowed ? "可对外" : "不对外"}`}
				onChange={onToggle}
			/>
		</li>
	);
}

function RuleGroup({
	title,
	hint,
	rules,
	busy,
	onToggle,
}: {
	title: string;
	hint: string;
	rules: DisclosureRule[];
	busy: string | null;
	onToggle: (rule: DisclosureRule, next: boolean) => void;
}) {
	return (
		<section className="rounded-card border border-line bg-bg">
			<div className="px-4 pt-3 pb-2">
				<h3 className="text-14 font-semibold text-ink">{title}</h3>
				<p className="text-12 text-muted">{hint}</p>
			</div>
			<ul className="divide-y divide-line border-t border-line">
				{rules.map((r) => (
					<RuleRow
						key={r.category}
						rule={r}
						busy={busy === r.category}
						onToggle={(next) => onToggle(r, next)}
					/>
				))}
			</ul>
		</section>
	);
}

/**
 * 对外政策：分身替我回答别人时，哪些类别的记忆可以说（逐类开关），以及我写给分身的自然语言政策。
 * 来自对方也在场的交流不受开关影响（对方本来就知道）。
 */
export function PolicyPanel({ onEditPolicy }: { onEditPolicy: () => void }) {
	const policy = useStore(
		(s) => s.me?.agents.find((a) => a.role === "front")?.delegationPolicy ?? "",
	);
	const [rules, setRules] = useState<DisclosureRule[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setFailed(false);
		try {
			setRules((await api.disclosure()).rules);
		} catch {
			setFailed(true);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const toggle = async (rule: DisclosureRule, allowed: boolean) => {
		setBusy(rule.category);
		setError(null);
		try {
			setRules(
				(await api.updateDisclosure({ category: rule.category, allowed }))
					.rules,
			);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(null);
		}
	};

	if (failed) return <ErrorState text="对外政策加载失败。" onRetry={load} />;
	if (!rules) return <LoadingRows rows={4} />;
	const open = rules.filter((r) =>
		DEFAULT_DISCLOSED_CATEGORIES.has(r.category),
	);
	const closed = rules.filter(
		(r) => !DEFAULT_DISCLOSED_CATEGORIES.has(r.category),
	);
	return (
		<div className="flex flex-col gap-3">
			<section className="rounded-card border border-line bg-bg p-4">
				<div className="flex items-start gap-3">
					<div className="min-w-0 flex-1">
						<h3 className="text-14 font-semibold text-ink">写给分身的政策</h3>
						<p
							className={cx(
								"mt-1 text-14 whitespace-pre-wrap break-words",
								policy ? "text-ink" : "text-muted",
							)}
						>
							{policy || "还没写。没写时分身只回答资料和记忆里明确写着的内容。"}
						</p>
					</div>
					<Button onClick={onEditPolicy}>编辑</Button>
				</div>
			</section>
			<p className="text-13 text-muted">
				分身替你回答别人时，按下面的类别决定能不能用你的记忆。对方也在场的交流不受这里限制；来自你与其他同事的交流，分身只转述事实，不透露是谁、在哪说的。
			</p>
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<RuleGroup
				title="默认可对外"
				hint="工作上的事，同事问起时分身可以直接答。"
				rules={open}
				busy={busy}
				onToggle={(r, next) => void toggle(r, next)}
			/>
			<RuleGroup
				title="默认不对外"
				hint="个人与敏感信息，打开前请想清楚。"
				rules={closed}
				busy={busy}
				onToggle={(r, next) => void toggle(r, next)}
			/>
		</div>
	);
}
