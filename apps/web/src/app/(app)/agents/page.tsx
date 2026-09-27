"use client";

import { PageHeader } from "@/components/page-header";
import { Avatar } from "@/components/ui/avatar";
import { SoonButton } from "@/components/ui/button";
import { useStore } from "@/lib/store";

/** 代理组：我的代理一览；设置（描述、授权、模型）在代理引擎阶段开放。 */
export default function AgentsPage() {
	const me = useStore((s) => s.me);
	if (!me) return null;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				back="/me"
				title="代理组"
				subtitle={`${me.agents.length} 位代理`}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-thread flex-col items-center px-4 py-12 text-center md:px-6">
					<div className="flex flex-wrap items-end justify-center gap-8">
						{me.agents.map((a) => (
							<div
								key={a.principal.id}
								className="flex w-40 flex-col items-center gap-2"
							>
								<Avatar principal={a.principal} size={72} />
								<p className="text-14 font-semibold text-ink">
									{a.principal.displayName}
								</p>
								<p className="text-12 text-muted">
									{a.role === "front"
										? "幕僚长 · 对外代表你"
										: "专员 · 只替你办事"}
								</p>
							</div>
						))}
					</div>
					<p className="mt-8 max-w-sm text-14 text-balance text-muted">
						在这里给每位代理写职责、定授权边界、选模型。代理设置很快开放，现在可以直接在消息里和它们对话。
					</p>
					<div className="mt-4">
						<SoonButton variant="primary">设置代理</SoonButton>
					</div>
				</div>
			</div>
		</div>
	);
}
