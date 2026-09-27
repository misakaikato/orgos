"use client";

import {
	GROUP_ROUTING_LABEL,
	GROUP_ROUTINGS,
	type GroupRouting,
	type ModelGroup,
	type ModelOption,
} from "@orgos/protocol";
import { type FormEvent, useId, useState } from "react";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, selectClass } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/states";
import { api } from "@/lib/api";

const ROUTING_HINT: Record<GroupRouting, string> = {
	order: "按顺序尝试：前一个出错（5xx、限流、连不上）再试下一个。",
	rotate: "每次从下一个成员开始，分摊用量；出错同样顺延。",
};

function GroupForm({
	group,
	models,
	onSaved,
	onCancel,
}: {
	group?: ModelGroup;
	models: ModelOption[];
	onSaved: (next: ModelGroup) => void;
	onCancel: () => void;
}) {
	const ids = useId();
	const [name, setName] = useState(group?.name ?? "");
	const [routing, setRouting] = useState<GroupRouting>(
		group?.routing ?? "order",
	);
	const [members, setMembers] = useState<string[]>(group?.members ?? []);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const toggle = (ref: string) =>
		setMembers((m) =>
			m.includes(ref) ? m.filter((x) => x !== ref) : [...m, ref],
		);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const req = { name: name.trim(), routing, members };
			const { group: next } = group
				? await api.updateGroup(group.id, req)
				: await api.createGroup(req);
			onSaved(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : "没保存成功");
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			onSubmit={submit}
			className="flex flex-col gap-3 rounded-card border border-line bg-bg p-4"
		>
			<Field
				label="组名"
				value={name}
				maxLength={40}
				required
				onChange={(e) => setName(e.target.value)}
			/>
			<div className="flex flex-col gap-1.5">
				<label
					htmlFor={`${ids}-routing`}
					className="text-13 font-medium text-ink"
				>
					路由方式
				</label>
				<select
					id={`${ids}-routing`}
					value={routing}
					onChange={(e) => setRouting(e.target.value as GroupRouting)}
					className={selectClass}
				>
					{GROUP_ROUTINGS.map((r) => (
						<option key={r} value={r}>
							{GROUP_ROUTING_LABEL[r]}
						</option>
					))}
				</select>
				<p className="text-12 text-muted">{ROUTING_HINT[routing]}</p>
			</div>
			<fieldset className="flex flex-col gap-1.5">
				<legend className="mb-1.5 text-13 font-medium text-ink">
					成员（按勾选的先后排序）
				</legend>
				{models.length === 0 ? (
					<p className="text-13 text-muted">先在厂商里开放模型。</p>
				) : (
					models.map((m) => {
						const at = members.indexOf(m.ref);
						return (
							<label
								key={m.ref}
								className="flex items-center gap-2 text-14 text-ink"
							>
								<input
									type="checkbox"
									checked={at >= 0}
									onChange={() => toggle(m.ref)}
									className="accent-accent"
								/>
								<span className="break-all">{m.label}</span>
								{at >= 0 ? <Tag>{`第 ${at + 1} 个`}</Tag> : null}
							</label>
						);
					})
				)}
			</fieldset>
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button
					type="submit"
					variant="primary"
					disabled={saving || !name.trim() || members.length === 0}
				>
					{saving ? "保存中…" : "保存"}
				</Button>
				<Button disabled={saving} onClick={onCancel}>
					取消
				</Button>
			</div>
		</form>
	);
}

/** 路由组：一组模型当一个用（`group/<id>`），依次尝试或轮换。 */
export function GroupsSection({
	groups,
	models,
	onChange,
}: {
	groups: ModelGroup[];
	models: ModelOption[];
	onChange: (next: ModelGroup[]) => void;
}) {
	const [editing, setEditing] = useState<string | "new" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const labelOf = (ref: string) =>
		models.find((m) => m.ref === ref)?.label ?? `${ref}（未开放）`;

	const remove = async (id: string) => {
		setError(null);
		try {
			await api.deleteGroup(id);
			onChange(groups.filter((g) => g.id !== id));
		} catch (e) {
			setError(e instanceof Error ? e.message : "没删成功");
		}
	};

	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-16 font-semibold text-ink">路由组</h2>
			{groups.length === 0 && editing !== "new" ? (
				<EmptyState
					compact
					mascotId="orgos-groups"
					text="还没有路由组。把几个模型编成一组，出错时自动换下一个。"
					className="rounded-card bg-bg"
				/>
			) : null}
			{groups.map((g) =>
				editing === g.id ? (
					<GroupForm
						key={g.id}
						group={g}
						models={models}
						onCancel={() => setEditing(null)}
						onSaved={(next) => {
							setEditing(null);
							onChange(groups.map((x) => (x.id === next.id ? next : x)));
						}}
					/>
				) : (
					<article
						key={g.id}
						className="flex flex-col gap-2 rounded-card border border-line bg-bg p-4"
					>
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-14 font-semibold text-ink">{g.name}</h3>
							<Tag>{GROUP_ROUTING_LABEL[g.routing]}</Tag>
						</div>
						<ol className="flex list-decimal flex-col gap-0.5 pl-5 text-13 text-ink">
							{g.members.map((m) => (
								<li key={m} className="break-all">
									{labelOf(m)}
								</li>
							))}
						</ol>
						<div className="flex gap-2">
							<Button onClick={() => setEditing(g.id)}>编辑</Button>
							<Button variant="danger" onClick={() => void remove(g.id)}>
								删除
							</Button>
						</div>
					</article>
				),
			)}
			{editing === "new" ? (
				<GroupForm
					models={models}
					onCancel={() => setEditing(null)}
					onSaved={(next) => {
						setEditing(null);
						onChange([...groups, next]);
					}}
				/>
			) : (
				<div>
					<Button onClick={() => setEditing("new")}>新建路由组</Button>
				</div>
			)}
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
		</section>
	);
}
