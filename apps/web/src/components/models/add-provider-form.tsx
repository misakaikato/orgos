"use client";

import {
	GATEWAY_PROTOCOL_LABEL,
	GATEWAY_PROTOCOLS,
	type GatewayProtocol,
	type ModelProvider,
	PROVIDER_NAME_RE,
	PROVIDER_PRESETS,
	type ProviderEndpoints,
} from "@orgos/protocol";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, selectClass } from "@/components/ui/input";
import { api } from "@/lib/api";

const CUSTOM = "custom";

/**
 * 添加厂商：选预设（端点自动填好，可改）或自定义（填名称与端点），填 key（只写不读）。
 * 名字用在模型引用 `名字/模型` 里，建好后不能改。
 */
export function AddProviderForm({
	taken,
	onCreated,
	onCancel,
}: {
	/** 已有的厂商名。 */
	taken: readonly string[];
	onCreated: (provider: ModelProvider) => void;
	onCancel: () => void;
}) {
	const ids = useId();
	const firstFree =
		PROVIDER_PRESETS.find((p) => !taken.includes(p.id)) ?? PROVIDER_PRESETS[0];
	const [preset, setPreset] = useState(firstFree?.id ?? CUSTOM);
	const [name, setName] = useState(firstFree?.id ?? "");
	const [endpoints, setEndpoints] = useState<ProviderEndpoints>(
		firstFree?.endpoints ?? {},
	);
	const [key, setKey] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const def = PROVIDER_PRESETS.find((p) => p.id === preset);

	const pick = (id: string) => {
		setPreset(id);
		const next = PROVIDER_PRESETS.find((p) => p.id === id);
		setName(next?.id ?? "");
		setEndpoints(next?.endpoints ?? {});
	};
	const setEndpoint = (p: GatewayProtocol, url: string) =>
		setEndpoints((e) => ({ ...e, [p]: url.trim() || undefined }));

	const nameOk =
		PROVIDER_NAME_RE.test(name) && name !== "group" && !taken.includes(name);
	const hasEndpoint = GATEWAY_PROTOCOLS.some((p) => endpoints[p]);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const { provider } = await api.createProvider({
				name,
				...(def ? { preset: def.id } : {}),
				endpoints,
				...(key.trim() ? { apiKey: key.trim() } : {}),
				exposedModels: [],
			});
			onCreated(provider);
		} catch (err) {
			setError(err instanceof Error ? err.message : "没加成功");
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			onSubmit={submit}
			className="flex flex-col gap-3 rounded-card border border-line bg-bg p-4"
		>
			<h3 className="text-16 font-semibold text-ink">添加厂商</h3>
			<div className="flex flex-col gap-1.5">
				<label
					htmlFor={`${ids}-preset`}
					className="text-13 font-medium text-ink"
				>
					厂商
				</label>
				<select
					id={`${ids}-preset`}
					value={preset}
					onChange={(e) => pick(e.target.value)}
					className={selectClass}
				>
					{PROVIDER_PRESETS.map((p) => (
						<option key={p.id} value={p.id}>
							{p.label}
						</option>
					))}
					<option value={CUSTOM}>自定义</option>
				</select>
			</div>
			<Field
				label="名称"
				value={name}
				maxLength={40}
				required
				hint="用在模型引用里（名称/模型），建好后不能改。"
				error={
					name && !nameOk
						? taken.includes(name)
							? "已有同名厂商"
							: "只能用小写字母、数字、- 与 _，且不能叫 group"
						: null
				}
				onChange={(e) => setName(e.target.value.toLowerCase())}
			/>
			{GATEWAY_PROTOCOLS.map((p) => (
				<Field
					key={p}
					label={`${GATEWAY_PROTOCOL_LABEL[p]} 端点`}
					type="url"
					placeholder={def ? "该厂商没有这种协议的端点" : "https://…"}
					value={endpoints[p] ?? ""}
					onChange={(e) => setEndpoint(p, e.target.value)}
				/>
			))}
			<p className="text-12 text-muted">
				至少填一种。调用方说的协议厂商没有时，网关会翻译成它有的协议。
			</p>
			<Field
				label="API key"
				type="password"
				autoComplete="new-password"
				value={key}
				hint={
					def && !def.needsKey
						? "本机推理服务可以不填。"
						: "只写不读：加密保存，之后不会再显示。"
				}
				onChange={(e) => setKey(e.target.value)}
			/>
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button
					type="submit"
					variant="primary"
					disabled={saving || !nameOk || !hasEndpoint}
				>
					{saving ? "添加中…" : "添加"}
				</Button>
				<Button disabled={saving} onClick={onCancel}>
					取消
				</Button>
			</div>
		</form>
	);
}
