"use client";

import type { Principal } from "@orgos/protocol";
import { Mascot } from "@/components/mascot";

/**
 * "正在工作"（DESIGN.md §4）：消息列末尾，代理的团子（工作动画）+ 一个小气泡。
 * 思考时气泡里是三个跳动的圆点；执行工具时换成一句灰字（`label`）。
 */
export function WorkingIndicator({
	agent,
	label,
}: {
	agent: Pick<Principal, "id" | "displayName">;
	/** 执行工具时的说明，例如"正在执行命令…"；不传则显示三点。 */
	label?: string;
}) {
	return (
		<div
			role="status"
			aria-label={`${agent.displayName}${label ?? "正在思考"}`}
			className="mt-3 grid grid-cols-[32px_minmax(0,1fr)] gap-x-2"
		>
			<Mascot id={agent.id} size={32} state="working" />
			<div className="flex items-center">
				<div className="inline-flex h-10 items-center rounded-bubble border border-line bg-bg px-4">
					{label ? (
						<span className="text-13 text-muted">{label}</span>
					) : (
						<span aria-hidden="true" className="flex items-center gap-1">
							{[0, 150, 300].map((delay) => (
								<span
									key={delay}
									style={{ animationDelay: `${delay}ms` }}
									className="size-1.5 animate-typing-dot rounded-pill bg-muted motion-reduce:animate-none"
								/>
							))}
						</span>
					)}
				</div>
			</div>
		</div>
	);
}
