"use client";

import { askUnitLabel, type UnitDetailResponse } from "@orgos/protocol";
import { useCallback, useEffect, useState } from "react";
import { AnswersPanel } from "@/components/agents/answers-panel";
import { MemoryPanel } from "@/components/agents/memory-panel";
import { MemoryUnitProvider } from "@/components/agents/memory-shared";
import { DisclosureRules } from "@/components/agents/policy-panel";
import { UnitNotes } from "@/components/org/unit-notes";
import { UnitOverview } from "@/components/org/unit-overview";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { ApiError, api } from "@/lib/api";
import { useOpenDm, usePrincipalMap } from "@/lib/hooks";
import { loadOrg, useStore } from "@/lib/store";

type Tab = "overview" | "notes" | "memory" | "answers" | "policy";

const PUBLIC_TABS: { key: Tab; label: string }[] = [
	{ key: "overview", label: "概况" },
	{ key: "notes", label: "资料" },
];

/** 负责人另外能管理单元的记忆、代答记录与对外政策（复用个人记忆页的组件与接口）。 */
const HEAD_TABS: { key: Tab; label: string }[] = [
	...PUBLIC_TABS,
	{ key: "memory", label: "记忆" },
	{ key: "answers", label: "代答记录" },
	{ key: "policy", label: "对外政策" },
];

/**
 * 单元页：负责人与成员、章程（负责人可编辑）、单元资料（成员可见 unit 级）、单元分身最近的决定；
 * 负责人另有单元记忆、单元代答记录与对外政策。从通讯录的组织树进入，导航轨不新增入口。
 */
export function UnitView({ unitId }: { unitId: string }) {
	const meId = useStore((s) => s.me?.principal.id ?? "");
	const map = usePrincipalMap();
	const { open, pendingId, error: openError } = useOpenDm();
	const [detail, setDetail] = useState<UnitDetailResponse | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("overview");

	const load = useCallback(async () => {
		setFailed(null);
		try {
			setDetail(await api.unitDetail(unitId));
		} catch (e) {
			setFailed(
				e instanceof ApiError && e.status === 404
					? "找不到这个部门。"
					: "部门信息加载失败。",
			);
		}
	}, [unitId]);

	useEffect(() => {
		void load();
	}, [load]);

	const reload = () => {
		void load();
		void loadOrg().catch(() => {});
	};

	if (failed)
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<PageHeader back="/contacts" title="部门" />
				<ErrorState text={failed} onRetry={load} className="m-6" />
			</div>
		);
	if (!detail)
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<PageHeader back="/contacts" title="部门" />
				<LoadingRows rows={4} className="m-6" />
			</div>
		);

	const { unit } = detail;
	const name = unit.unit.displayName;
	const head = detail.myRole === "head";
	const twinId = unit.twin.id;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				back="/contacts"
				title={name}
				subtitle={`负责人 ${unit.head.displayName} · ${unit.members.length} 人`}
				actions={
					<Button
						variant="primary"
						disabled={pendingId === twinId}
						onClick={() => void open(twinId)}
					>
						{pendingId === twinId ? "打开中…" : askUnitLabel(name)}
					</Button>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto bg-sidebar">
				<div className="mx-auto flex w-full max-w-thread flex-col gap-4 px-4 py-6 md:px-6">
					{openError ? (
						<p role="alert" className="text-13 text-danger">
							{openError}
						</p>
					) : null}
					<Tabs
						tabs={head ? HEAD_TABS : PUBLIC_TABS}
						tab={tab}
						onChange={setTab}
						label={name}
					/>
					<MemoryUnitProvider value={unit.unit.id}>
						{tab === "overview" ? (
							<UnitOverview detail={detail} meId={meId} onChanged={reload} />
						) : tab === "notes" ? (
							<UnitNotes detail={detail} map={map} onChanged={reload} />
						) : !head ? null : tab === "memory" ? (
							<MemoryPanel />
						) : tab === "answers" ? (
							<AnswersPanel />
						) : (
							<div className="flex flex-col gap-3">
								<DisclosureRules
									intro={`${unit.twin.displayName}替${name}回答非成员时，按下面的类别决定能不能用${name}的记忆；成员问起不受限制。来自部门内部的内容给非成员时一律不带成员姓名。`}
								/>
							</div>
						)}
					</MemoryUnitProvider>
				</div>
			</div>
		</div>
	);
}
