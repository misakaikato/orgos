"use client";

import type { ModelProvider } from "@orgos/protocol";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

/**
 * 勾选厂商开放给本组织的模型：先从厂商的 /models 拉列表，拉不到就手填。
 * 已开放的模型总在列表里（即使厂商列表里没有）。
 */
export function ModelPicker({
	provider,
	onSaved,
	onCancel,
}: {
	provider: ModelProvider;
	onSaved: (next: ModelProvider) => void;
	onCancel: () => void;
}) {
	const [fetched, setFetched] = useState<string[] | null>(null);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [chosen, setChosen] = useState<string[]>(provider.exposedModels);
	const [manual, setManual] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		api
			.providerModels(provider.id)
			.then((r) => {
				if (!alive) return;
				setFetched(r.models);
				setFetchError(r.error ?? null);
			})
			.catch((e: unknown) => {
				if (!alive) return;
				setFetched([]);
				setFetchError(e instanceof Error ? e.message : "拉取失败");
			});
		return () => {
			alive = false;
		};
	}, [provider.id]);

	const all = [...new Set([...chosen, ...(fetched ?? [])])];
	const toggle = (m: string) =>
		setChosen((c) => (c.includes(m) ? c.filter((x) => x !== m) : [...c, m]));

	const addManual = (e: FormEvent) => {
		e.preventDefault();
		const m = manual.trim();
		if (m && !chosen.includes(m)) setChosen((c) => [...c, m]);
		setManual("");
	};

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const { provider: next } = await api.updateProvider(provider.id, {
				exposedModels: chosen,
			});
			onSaved(next);
		} catch (e) {
			setError(e instanceof Error ? e.message : "没保存成功");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="mt-3 flex flex-col gap-3 rounded-row border border-line px-3 py-3">
			<p className="text-13 font-medium text-ink">开放给本组织的模型</p>
			{fetched === null ? (
				<p className="text-13 text-muted">正在从厂商拉取模型列表…</p>
			) : fetchError ? (
				<p className="text-13 text-muted">
					拉不到模型列表（{fetchError}），请在下面手填模型 id。
				</p>
			) : null}
			{all.length > 0 ? (
				<ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
					{all.map((m) => (
						<li key={m}>
							<label className="flex items-center gap-2 text-14 text-ink">
								<input
									type="checkbox"
									checked={chosen.includes(m)}
									onChange={() => toggle(m)}
									className="accent-accent"
								/>
								<span className="break-all">{m}</span>
							</label>
						</li>
					))}
				</ul>
			) : null}
			<form onSubmit={addManual} className="flex gap-2">
				<Input
					aria-label="手填模型 id"
					placeholder="手填模型 id"
					value={manual}
					onChange={(e) => setManual(e.target.value)}
				/>
				<Button type="submit" disabled={!manual.trim()}>
					添加
				</Button>
			</form>
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button variant="primary" disabled={saving} onClick={save}>
					{saving ? "保存中…" : `保存（${chosen.length} 个）`}
				</Button>
				<Button disabled={saving} onClick={onCancel}>
					取消
				</Button>
			</div>
		</div>
	);
}
