"use client";

import {
	AGENT_ROLE_DUTY,
	AGENT_ROLE_LABEL,
	type Agent,
	type AgentUsage,
} from "@orgos/protocol";
import { type FormEvent, useState } from "react";
import { Mascot } from "@/components/mascot";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, TextAreaField } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { formatTokens, formatUsd } from "@/lib/format";
import { useOpenDm } from "@/lib/hooks";

function usageLine(usage: AgentUsage | undefined): string {
	if (!usage || usage.requests === 0) return "还没有调用过模型";
	return [
		`${usage.requests} 次请求`,
		`${formatTokens(usage.inputTokens + usage.outputTokens)} tokens`,
		formatUsd(usage.costMicroUsd),
	].join(" · ");
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : "操作失败";
}

type Draft = {
	displayName: string;
	description: string;
	delegationPolicy: string;
};

function EditForm({
	agent,
	onDone,
	onCancel,
}: {
	agent: Agent;
	onDone: (next: Agent) => void;
	onCancel: () => void;
}) {
	const front = agent.role === "front";
	const [draft, setDraft] = useState<Draft>({
		displayName: agent.principal.displayName,
		description: agent.description,
		delegationPolicy: agent.delegationPolicy,
	});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const { agent: next } = await api.updateAgent(agent.principal.id, {
				displayName: draft.displayName,
				description: draft.description,
				...(front ? { delegationPolicy: draft.delegationPolicy } : {}),
			});
			onDone(next);
		} catch (err) {
			setError(errorText(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<form onSubmit={submit} className="mt-3 flex flex-col gap-3">
			<Field
				label="名字"
				value={draft.displayName}
				maxLength={40}
				required
				onChange={(e) => patch({ displayName: e.target.value })}
			/>
			<TextAreaField
				label="职责说明"
				hint="会写进它的系统提示：它负责什么、怎么做事。"
				value={draft.description}
				maxLength={2000}
				onChange={(e) => patch({ description: e.target.value })}
			/>
			{front ? (
				<TextAreaField
					label="对外政策"
					hint="同事问你的分身时，它按这里的授权回答；超出的会转给你本人。"
					value={draft.delegationPolicy}
					maxLength={2000}
					rows={4}
					onChange={(e) => patch({ delegationPolicy: e.target.value })}
				/>
			) : null}
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button type="submit" variant="primary" disabled={saving}>
					{saving ? "保存中…" : "保存"}
				</Button>
				<Button onClick={onCancel} disabled={saving}>
					取消
				</Button>
			</div>
		</form>
	);
}

/**
 * 代理组页的一张代理卡：团子、名字与角色、职责、（分身的）对外政策、用量；
 * 可编辑、开聊；助手可删除（分身不可删）。
 */
export function AgentCard({
	agent,
	usage,
	onChanged,
	onDeleted,
}: {
	agent: Agent;
	usage: AgentUsage | undefined;
	onChanged: (next: Agent) => void;
	onDeleted: (id: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { open, pendingId } = useOpenDm();
	const front = agent.role === "front";
	const id = agent.principal.id;

	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.deleteAgent(id);
			onDeleted(id);
		} catch (e) {
			setError(errorText(e));
			setBusy(false);
		}
	};

	return (
		<section className="flex gap-4 rounded-card border border-line bg-bg p-4">
			<Mascot id={id} size={72} className="shrink-0" />
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<h2 className="truncate text-16 font-semibold text-ink">
						{agent.principal.displayName}
					</h2>
					<Tag>{AGENT_ROLE_LABEL[agent.role]}</Tag>
				</div>
				<p className="truncate text-12 text-muted">
					@{agent.principal.handle} · {AGENT_ROLE_DUTY[agent.role]}
				</p>
				{editing ? (
					<EditForm
						agent={agent}
						onCancel={() => setEditing(false)}
						onDone={(next) => {
							setEditing(false);
							onChanged(next);
						}}
					/>
				) : (
					<>
						<p
							className={cx(
								"mt-2 text-14 whitespace-pre-wrap break-words",
								agent.description ? "text-ink" : "text-muted",
							)}
						>
							{agent.description || "还没写职责说明。"}
						</p>
						{front ? (
							<div className="mt-3 rounded-row bg-surface-2 px-3 py-2">
								<p className="text-12 font-medium text-muted">对外政策</p>
								<p
									className={cx(
										"text-14 whitespace-pre-wrap break-words",
										agent.delegationPolicy ? "text-ink" : "text-muted",
									)}
								>
									{agent.delegationPolicy ||
										"还没设置：分身只会回答你共享资料里明确写着的内容。"}
								</p>
							</div>
						) : null}
						<p className="mt-3 text-12 text-muted">{usageLine(usage)}</p>
						{error ? (
							<p role="alert" className="mt-2 text-12 text-danger">
								{error}
							</p>
						) : null}
						<div className="mt-3 flex flex-wrap gap-2">
							{confirming ? (
								<>
									<span className="self-center text-13 text-ink">
										删除后它不再回应，历史消息保留。
									</span>
									<Button variant="danger" disabled={busy} onClick={remove}>
										{busy ? "删除中…" : "确认删除"}
									</Button>
									<Button disabled={busy} onClick={() => setConfirming(false)}>
										取消
									</Button>
								</>
							) : (
								<>
									<Button
										disabled={pendingId === id}
										onClick={() => void open(id)}
									>
										和它聊天
									</Button>
									<Button onClick={() => setEditing(true)}>编辑</Button>
									{front ? null : (
										<Button
											variant="danger"
											onClick={() => setConfirming(true)}
										>
											删除
										</Button>
									)}
								</>
							)}
						</div>
					</>
				)}
			</div>
		</section>
	);
}
