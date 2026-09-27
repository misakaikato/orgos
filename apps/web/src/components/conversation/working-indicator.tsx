"use client";

import type { Principal } from "@orgos/protocol";
import {
	AgentName,
	fallbackPrincipal,
} from "@/components/conversation/message-item";
import { Mascot } from "@/components/mascot";
import type { AgentActivity } from "@/lib/activity";
import type { PrincipalMap } from "@/lib/principals";

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

/**
 * 代理正在流式输出的回复：与代理气泡同样的描边气泡 + 团子（工作动画）+ 名字行，
 * 文本末尾一个闪烁光标。落库后由正式气泡取代。
 */
export function DraftBubble({
	agent,
	text,
	map,
	meId,
}: {
	agent: Pick<Principal, "id" | "displayName" | "ownerId">;
	text: string;
	map: PrincipalMap;
	meId: string;
}) {
	return (
		<div
			aria-live="off"
			className="mt-3 grid grid-cols-[32px_minmax(0,1fr)] gap-x-2"
		>
			<div className="pt-0.5">
				<Mascot id={agent.id} size={32} state="working" />
			</div>
			<div className="flex min-w-0 flex-col items-start">
				<div className="mb-1 max-w-full">
					<AgentName agent={agent} map={map} meId={meId} />
				</div>
				<div className="min-w-0 max-w-[72%] rounded-bubble border border-line bg-bg px-3.5 py-2.5">
					<p className="text-15 whitespace-pre-wrap break-words text-ink [overflow-wrap:anywhere]">
						{text}
						<span
							aria-hidden="true"
							className="ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-[0.2em] animate-caret bg-ink motion-reduce:animate-none"
						/>
					</p>
				</div>
			</div>
		</div>
	);
}

/** 会话里所有正在工作的代理：有草稿显示草稿气泡，否则显示"正在工作"。 */
export function AgentActivityRows({
	activity,
	map,
	meId,
}: {
	activity: Readonly<Record<string, AgentActivity>> | undefined;
	map: PrincipalMap;
	meId: string;
}) {
	if (!activity) return null;
	return (
		<>
			{Object.entries(activity).map(([agentId, a]) => {
				const agent = map.get(agentId) ?? fallbackPrincipal(agentId, "agent");
				return a.draft ? (
					<DraftBubble
						key={agentId}
						agent={agent}
						text={a.draft}
						map={map}
						meId={meId}
					/>
				) : (
					<WorkingIndicator
						key={agentId}
						agent={agent}
						label={a.state === "tool" ? a.label : undefined}
					/>
				);
			})}
		</>
	);
}
