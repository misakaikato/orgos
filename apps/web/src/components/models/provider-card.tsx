"use client";

import {
	findPreset,
	GATEWAY_PROTOCOL_LABEL,
	GATEWAY_PROTOCOLS,
	type ModelProvider,
	type ProviderTestResult,
} from "@orgos/protocol";
import { type FormEvent, useState } from "react";
import { ModelPicker } from "@/components/models/model-picker";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cx } from "@/lib/cx";

type Mode = "view" | "models" | "key" | "delete";

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : "操作失败";
}

/** key 只写不读：填新的替换，留空清除。 */
function KeyForm({
	provider,
	onSaved,
	onCancel,
}: {
	provider: ModelProvider;
	onSaved: (next: ModelProvider) => void;
	onCancel: () => void;
}) {
	const [key, setKey] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const { provider: next } = await api.updateProvider(provider.id, {
				apiKey: key.trim(),
			});
			onSaved(next);
		} catch (err) {
			setError(errorText(err));
		} finally {
			setSaving(false);
		}
	};
	return (
		<form onSubmit={submit} className="mt-3 flex flex-col gap-3">
			<Field
				label="新的 key"
				type="password"
				autoComplete="new-password"
				value={key}
				hint="只写不读：保存后不会再显示。留空保存即清除 key。"
				onChange={(e) => setKey(e.target.value)}
			/>
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button type="submit" variant="primary" disabled={saving}>
					{saving ? "保存中…" : "保存"}
				</Button>
				<Button disabled={saving} onClick={onCancel}>
					取消
				</Button>
			</div>
		</form>
	);
}

function TestResults({ results }: { results: ProviderTestResult[] }) {
	if (results.length === 0)
		return (
			<p className="mt-3 text-13 text-muted">这个厂商没有可测试的端点。</p>
		);
	return (
		<ul className="mt-3 flex flex-col gap-2 rounded-row bg-surface-2 px-3 py-2">
			{results.map((r) => (
				<li key={r.protocol} className="flex flex-col gap-0.5">
					<span className="flex items-center gap-2 text-13 font-medium text-ink">
						<span
							aria-hidden="true"
							className={cx(
								"size-2 rounded-pill",
								r.ok ? "bg-good" : "bg-danger",
							)}
						/>
						{GATEWAY_PROTOCOL_LABEL[r.protocol]}
						<span className="font-normal text-muted">
							{r.ok ? "通" : "不通"} · {r.latencyMs} ms
							{r.httpStatus ? ` · HTTP ${r.httpStatus}` : ""}
						</span>
					</span>
					<span
						className={cx(
							"text-13 break-words",
							r.ok ? "text-ink" : "text-danger",
						)}
					>
						{r.message}
					</span>
				</li>
			))}
		</ul>
	);
}

/**
 * 一家厂商：名字、预设、各协议端点、key 是否已配、开放的模型；
 * 可测试（每种协议一个最小请求）、勾选开放模型、换 key、删除。
 */
export function ProviderCard({
	provider,
	initialMode = "view",
	onChanged,
	onDeleted,
}: {
	provider: ModelProvider;
	initialMode?: Mode;
	onChanged: (next: ModelProvider) => void;
	onDeleted: (id: string) => void;
}) {
	const [mode, setMode] = useState<Mode>(initialMode);
	const [testing, setTesting] = useState(false);
	const [results, setResults] = useState<ProviderTestResult[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const preset = findPreset(provider.preset);

	const test = async () => {
		setTesting(true);
		setError(null);
		setResults(null);
		try {
			setResults((await api.testProvider(provider.id)).results);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setTesting(false);
		}
	};

	const remove = async () => {
		setError(null);
		try {
			await api.deleteProvider(provider.id);
			onDeleted(provider.id);
		} catch (e) {
			setError(errorText(e));
		}
	};

	const done = (next: ModelProvider) => {
		setMode("view");
		onChanged(next);
	};

	return (
		<section className="rounded-card border border-line bg-bg p-4">
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="text-16 font-semibold text-ink">{provider.name}</h3>
				<Tag>{preset?.label ?? "自定义"}</Tag>
				{provider.hasKey ? (
					<Tag tone="good">已配置 key</Tag>
				) : (
					<Tag>没有 key</Tag>
				)}
			</div>
			<dl className="mt-3 flex flex-col gap-1">
				{GATEWAY_PROTOCOLS.flatMap((p) =>
					provider.endpoints[p]
						? [
								<div key={p} className="flex flex-wrap gap-x-2 text-13">
									<dt className="text-muted">{GATEWAY_PROTOCOL_LABEL[p]}</dt>
									<dd className="break-all text-ink">
										{provider.endpoints[p]}
									</dd>
								</div>,
							]
						: [],
				)}
			</dl>
			<div className="mt-3 flex flex-wrap gap-1.5">
				{provider.exposedModels.length > 0 ? (
					provider.exposedModels.map((m) => <Tag key={m}>{m}</Tag>)
				) : (
					<p className="text-13 text-muted">还没有开放任何模型。</p>
				)}
			</div>
			{mode === "models" ? (
				<ModelPicker
					provider={provider}
					onSaved={done}
					onCancel={() => setMode("view")}
				/>
			) : mode === "key" ? (
				<KeyForm
					provider={provider}
					onSaved={done}
					onCancel={() => setMode("view")}
				/>
			) : null}
			{results ? <TestResults results={results} /> : null}
			{error ? (
				<p role="alert" className="mt-2 text-12 text-danger">
					{error}
				</p>
			) : null}
			{mode === "view" ? (
				<div className="mt-3 flex flex-wrap gap-2">
					<Button disabled={testing} onClick={() => void test()}>
						{testing ? "测试中…" : "测试"}
					</Button>
					<Button onClick={() => setMode("models")}>选择模型</Button>
					<Button onClick={() => setMode("key")}>更换 key</Button>
					<Button variant="danger" onClick={() => setMode("delete")}>
						删除
					</Button>
				</div>
			) : mode === "delete" ? (
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<span className="text-13 text-ink">
						删除后，用它的代理与路由组成员会不可用。
					</span>
					<Button variant="danger" onClick={() => void remove()}>
						确认删除
					</Button>
					<Button onClick={() => setMode("view")}>取消</Button>
				</div>
			) : null}
		</section>
	);
}
