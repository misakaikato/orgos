"use client";

import type { Agent, AgentUsage } from "@orgos/protocol";
import { useEffect, useState } from "react";
import { AgentCard } from "@/components/agents/agent-card";
import { NewAgentForm } from "@/components/agents/new-agent-form";
import { NotesPanel } from "@/components/agents/notes-panel";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { refreshMyAgents, setMyAgents, useStore } from "@/lib/store";

type Tab = "agents" | "notes";

const TABS: { key: Tab; label: string }[] = [
	{ key: "agents", label: "代理" },
	{ key: "notes", label: "资料" },
];

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
	return (
		<div
			role="tablist"
			aria-label="代理组"
			className="flex w-full max-w-xs gap-1 rounded-pill bg-surface-2 p-1"
		>
			{TABS.map((t) => (
				<button
					key={t.key}
					type="button"
					role="tab"
					aria-selected={tab === t.key}
					onClick={() => onChange(t.key)}
					className={cx(
						"inline-flex h-7 flex-1 items-center justify-center rounded-pill text-13 transition-colors duration-150",
						tab === t.key
							? "bg-bg font-medium text-ink shadow-card-hover"
							: "text-muted hover:text-ink",
					)}
				>
					{t.label}
				</button>
			))}
		</div>
	);
}

function AgentsPanel({
	agents,
	ownerHandle,
}: {
	agents: Agent[];
	ownerHandle: string;
}) {
	const [usage, setUsage] = useState<Map<string, AgentUsage>>(new Map());
	const [creating, setCreating] = useState(false);

	useEffect(() => {
		void refreshMyAgents().catch(() => {});
		void api
			.usage()
			.then(({ byAgent }) =>
				setUsage(new Map(byAgent.map((u) => [u.agentId, u]))),
			)
			.catch(() => {});
	}, []);

	return (
		<div className="flex flex-col gap-3">
			{agents.map((agent) => (
				<AgentCard
					key={agent.principal.id}
					agent={agent}
					usage={usage.get(agent.principal.id)}
					onChanged={(next) =>
						setMyAgents(
							agents.map((a) =>
								a.principal.id === next.principal.id ? next : a,
							),
						)
					}
					onDeleted={(id) =>
						setMyAgents(agents.filter((a) => a.principal.id !== id))
					}
				/>
			))}
			{creating ? (
				<NewAgentForm
					ownerHandle={ownerHandle}
					onCancel={() => setCreating(false)}
					onCreated={(agent) => {
						setCreating(false);
						setMyAgents([...agents, agent]);
					}}
				/>
			) : (
				<div>
					<Button variant="primary" onClick={() => setCreating(true)}>
						新建助手
					</Button>
				</div>
			)}
		</div>
	);
}

/** 代理组：我的分身与助手（职责、对外政策、用量），以及它们可以引用的资料。 */
export default function AgentsPage() {
	const me = useStore((s) => s.me);
	const [tab, setTab] = useState<Tab>("agents");
	if (!me) return null;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				back="/me"
				title="代理组"
				subtitle={`${me.agents.length} 位代理`}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto bg-sidebar">
				<div className="mx-auto flex w-full max-w-thread flex-col gap-4 px-4 py-6 md:px-6">
					<Tabs tab={tab} onChange={setTab} />
					{tab === "agents" ? (
						<AgentsPanel agents={me.agents} ownerHandle={me.principal.handle} />
					) : (
						<NotesPanel />
					)}
				</div>
			</div>
		</div>
	);
}
