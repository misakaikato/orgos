"use client";

import { DEFAULT_ASSISTANT_NAME } from "@orgos/protocol";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/states";
import { useStore } from "@/lib/store";

/** 设备：把自己的电脑配对给助手用；配对在设备阶段开放。 */
export default function DevicesPage() {
	const ops = useStore((s) => s.me?.agents.find((a) => a.role !== "front"));
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader back="/me" title="设备" />
			<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
				<EmptyState
					mascotId={ops?.principal.id ?? "devices-empty"}
					text={`把你的电脑配对成设备后，${ops?.principal.displayName ?? `你的${DEFAULT_ASSISTANT_NAME}`}可以在上面读文件、跑命令；有风险的操作会先问你。`}
					action={{ label: "添加设备", soon: true }}
				/>
			</div>
		</div>
	);
}
