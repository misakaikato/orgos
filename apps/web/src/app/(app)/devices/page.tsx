"use client";

import { DEFAULT_ASSISTANT_NAME } from "@orgos/protocol";
import { useEffect, useState } from "react";
import { PairingPanel } from "@/components/devices/pairing-panel";
import { RunnerRow } from "@/components/devices/runner-row";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { checkLocalRunner, loadRunners, useStore } from "@/lib/store";

/**
 * 设备：把自己的电脑配对成设备，给助手用；可随时吊销。
 * 在桌面客户端里打开时，本机自动配对到当前账号，列表里标出"本机"。
 */
export default function DevicesPage() {
	const myAgents = useStore((s) => s.me?.agents);
	const runners = useStore((s) => s.runners);
	const status = useStore((s) => s.runnersStatus);
	const localRunnerId = useStore((s) => s.localRunnerId);
	const [adding, setAdding] = useState(false);

	useEffect(() => {
		void loadRunners();
		void checkLocalRunner();
	}, []);

	const agents = myAgents ?? [];
	const ops = agents.find((a) => a.role !== "front");
	const boundTo = (runnerId: string) =>
		agents
			.filter((a) => a.runnerId === runnerId)
			.map((a) => a.principal.displayName);
	const online = runners?.filter((r) => r.status === "online").length ?? 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				back="/me"
				title="设备"
				subtitle={
					runners && runners.length > 0
						? `${runners.length} 台 · ${online} 台在线`
						: null
				}
				actions={
					runners && runners.length > 0 && !adding ? (
						<Button variant="primary" onClick={() => setAdding(true)}>
							添加设备
						</Button>
					) : null
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto bg-sidebar">
				<div className="mx-auto flex w-full max-w-thread flex-col gap-4 px-4 py-6 md:px-6">
					{adding ? <PairingPanel onClose={() => setAdding(false)} /> : null}
					{runners === null && status === "error" ? (
						<ErrorState
							text="设备加载失败。"
							onRetry={() => void loadRunners()}
						/>
					) : runners === null ? (
						<LoadingRows rows={2} />
					) : runners.length === 0 ? (
						adding ? null : (
							<EmptyState
								mascotId={ops?.principal.id ?? "devices-empty"}
								text={`把你的电脑配对成设备后，${ops?.principal.displayName ?? `你的${DEFAULT_ASSISTANT_NAME}`}可以在上面读文件、跑命令；有风险的操作会先问你。`}
								action={{ label: "添加设备", onClick: () => setAdding(true) }}
							/>
						)
					) : (
						<ul className="flex flex-col gap-3">
							{runners.map((r) => (
								<RunnerRow
									key={r.id}
									runner={r}
									boundTo={boundTo(r.id)}
									local={r.id === localRunnerId}
								/>
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
	);
}
