"use client";

import {
	EXTERNAL_AGENT_MODE_LABEL,
	EXTERNAL_AGENT_MODES,
	type ExternalAgentMode,
	type ModelOption,
	type TenantSettings,
	type UpdateTenantSettingsRequest,
} from "@orgos/protocol";
import { useId, useState } from "react";
import { Switch, selectClass } from "@/components/ui/input";
import { cx } from "@/lib/cx";
import { updateTenantSettings } from "@/lib/store";

const MODE_HINT: Record<ExternalAgentMode, string> = {
	enterprise:
		"外部助手（Claude Code、Codex 等）经组织的模型网关调用模型，只在任务期间拿到本任务的令牌；用量计入组织。",
	personal: "外部助手用设备主人自己在那台设备上的登录，orgos 不注入、不计量。",
};

/** 租户默认模型与外部助手的模式（企业 / 个人，个人模式须先允许）。 */
export function SettingsSection({
	settings,
	options,
	onChange,
}: {
	settings: TenantSettings;
	options: ModelOption[];
	onChange: (next: TenantSettings) => void;
}) {
	const ids = useId();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const allowPersonal = settings.allowPersonalExternal ?? false;
	const mode = settings.externalAgentMode ?? "enterprise";
	const defaultModel = settings.defaultModel ?? "";
	const known = options.some((o) => o.ref === defaultModel);

	const patch = async (req: UpdateTenantSettingsRequest) => {
		setBusy(true);
		setError(null);
		try {
			onChange(await updateTenantSettings(req));
		} catch (e) {
			setError(e instanceof Error ? e.message : "没改成");
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-16 font-semibold text-ink">组织设置</h2>
			<div className="flex flex-col gap-4 rounded-card border border-line bg-bg p-4">
				<div className="flex flex-col gap-1.5">
					<label
						htmlFor={`${ids}-default`}
						className="text-13 font-medium text-ink"
					>
						默认模型
					</label>
					<select
						id={`${ids}-default`}
						value={defaultModel}
						disabled={busy || options.length === 0}
						onChange={(e) => void patch({ defaultModel: e.target.value })}
						className={selectClass}
					>
						{known ? null : (
							<option value={defaultModel}>{defaultModel}（未开放）</option>
						)}
						{options.map((o) => (
							<option key={o.ref} value={o.ref}>
								{o.label}
							</option>
						))}
					</select>
					<p className="text-12 text-muted">
						新建的代理默认用它；已有代理不变。
					</p>
				</div>
				<div className="flex flex-col gap-2 border-t border-line pt-4">
					<p className="text-13 font-medium text-ink">外部助手的模式</p>
					<div
						role="toolbar"
						aria-label="外部助手的模式"
						className="flex w-full max-w-xs gap-1 rounded-pill bg-surface-2 p-1"
					>
						{EXTERNAL_AGENT_MODES.map((m) => {
							const disabled = busy || (m === "personal" && !allowPersonal);
							return (
								<button
									key={m}
									type="button"
									aria-pressed={mode === m}
									disabled={disabled}
									onClick={() => void patch({ externalAgentMode: m })}
									className={cx(
										"inline-flex h-7 flex-1 items-center justify-center rounded-pill text-13 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
										mode === m
											? "bg-bg font-medium text-ink shadow-card-hover"
											: "text-muted hover:text-ink",
									)}
								>
									{EXTERNAL_AGENT_MODE_LABEL[m]}
								</button>
							);
						})}
					</div>
					<p className="text-12 text-muted">{MODE_HINT[mode]}</p>
					<div className="flex items-center gap-3">
						<p className="min-w-0 flex-1 text-13 text-ink">允许个人模式</p>
						<Switch
							label="允许个人模式"
							checked={allowPersonal}
							disabled={busy}
							onChange={(next) => void patch({ allowPersonalExternal: next })}
						/>
					</div>
					<p className="text-12 text-muted">
						关闭时外部助手一律走企业模式。只支持个人模式的助手（pi、Hermes）在企业模式下不能接活。
					</p>
				</div>
				{error ? (
					<p role="alert" className="text-12 text-danger">
						{error}
					</p>
				) : null}
			</div>
		</section>
	);
}
