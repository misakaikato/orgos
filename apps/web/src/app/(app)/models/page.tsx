"use client";

import type {
	ModelAdminResponse,
	ModelGroup,
	ModelOption,
	ModelProvider,
} from "@orgos/protocol";
import { useCallback, useEffect, useState } from "react";
import { AddProviderForm } from "@/components/models/add-provider-form";
import { GroupsSection } from "@/components/models/groups-section";
import { ProviderCard } from "@/components/models/provider-card";
import { SettingsSection } from "@/components/models/settings-section";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";

/**
 * 模型（仅租户 owner）：本组织所有模型调用都经服务端的模型网关。
 * 厂商与 key、开放的模型、路由组、默认模型、外部助手的模式。
 */
export default function ModelsPage() {
	const me = useStore((s) => s.me);
	const isOwner = Boolean(me?.tenant.inviteCode);
	const [data, setData] = useState<ModelAdminResponse | null>(null);
	const [options, setOptions] = useState<ModelOption[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [justAdded, setJustAdded] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const [admin, opts] = await Promise.all([
				api.modelAdmin(),
				api.modelOptions(),
			]);
			setData(admin);
			setOptions(opts.options);
		} catch (e) {
			setError(e instanceof Error ? e.message : "读取失败");
		}
	}, []);

	useEffect(() => {
		if (isOwner) void load();
	}, [isOwner, load]);

	const refreshOptions = () =>
		void api
			.modelOptions()
			.then((r) => setOptions(r.options))
			.catch(() => {});

	const setProviders = (providers: ModelProvider[]) => {
		setData((d) => (d ? { ...d, providers } : d));
		refreshOptions();
	};
	const setGroups = (groups: ModelGroup[]) => {
		setData((d) => (d ? { ...d, groups } : d));
		refreshOptions();
	};

	if (!me) return null;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader back="/me" title="模型" subtitle={me.tenant.name} />
			<div className="min-h-0 flex-1 overflow-y-auto bg-sidebar">
				<div className="mx-auto flex w-full max-w-thread flex-col gap-6 px-4 py-6 md:px-6">
					{!isOwner ? (
						<EmptyState
							mascotId="orgos-models"
							text="模型由组织的创建者管理。你的代理可以在「代理组」里从已开放的模型中选。"
							action={{ label: "去代理组", href: "/agents" }}
						/>
					) : error ? (
						<ErrorState text={error} onRetry={() => void load()} />
					) : !data ? (
						<LoadingRows rows={3} />
					) : (
						<>
							<section className="flex flex-col gap-3">
								<div>
									<h2 className="text-16 font-semibold text-ink">厂商</h2>
									<p className="text-13 text-muted">
										组织里的代理与外部助手都经这里的厂商调用模型；key
										加密保存，只写不读。
									</p>
								</div>
								{data.providers.length === 0 && !adding ? (
									<EmptyState
										mascotId="orgos-models"
										text="还没有厂商。加一家，代理才能说话。"
										action={{
											label: "添加厂商",
											onClick: () => setAdding(true),
										}}
										className="rounded-card bg-bg"
									/>
								) : null}
								{data.providers.map((p) => (
									<ProviderCard
										key={p.id}
										provider={p}
										initialMode={p.id === justAdded ? "models" : "view"}
										onChanged={(next) =>
											setProviders(
												data.providers.map((x) =>
													x.id === next.id ? next : x,
												),
											)
										}
										onDeleted={(id) =>
											setProviders(data.providers.filter((x) => x.id !== id))
										}
									/>
								))}
								{adding ? (
									<AddProviderForm
										taken={data.providers.map((p) => p.name)}
										onCancel={() => setAdding(false)}
										onCreated={(p) => {
											setAdding(false);
											setJustAdded(p.id);
											setProviders([...data.providers, p]);
										}}
									/>
								) : data.providers.length > 0 ? (
									<div>
										<Button onClick={() => setAdding(true)}>添加厂商</Button>
									</div>
								) : null}
							</section>
							<GroupsSection
								groups={data.groups}
								models={options.filter((o) => o.kind === "model")}
								onChange={setGroups}
							/>
							<SettingsSection
								settings={data.settings}
								options={options}
								onChange={(settings) =>
									setData((d) => (d ? { ...d, settings } : d))
								}
							/>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
