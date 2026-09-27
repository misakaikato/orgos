"use client";

import type {
	Note,
	UNIT_NOTE_VISIBILITIES,
	UnitDetailResponse,
} from "@orgos/protocol";
import { type FormEvent, useState } from "react";
import { errorText } from "@/components/agents/memory-shared";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Switch, TextAreaField } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/states";
import { api } from "@/lib/api";
import { formatListTime } from "@/lib/format";
import type { PrincipalMap } from "@/lib/principals";

type Visibility = (typeof UNIT_NOTE_VISIBILITIES)[number];
type Draft = { title: string; body: string; visibility: Visibility };

const SHARE_LABEL = "对全员公开";

function NoteForm({
	initial,
	submitLabel,
	onSubmit,
	onCancel,
}: {
	initial: Draft;
	submitLabel: string;
	onSubmit: (v: Draft) => Promise<void>;
	onCancel: () => void;
}) {
	const [title, setTitle] = useState(initial.title);
	const [body, setBody] = useState(initial.body);
	const [shared, setShared] = useState(initial.visibility === "shared");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			await onSubmit({ title, body, visibility: shared ? "shared" : "unit" });
		} catch (err) {
			setError(errorText(err));
			setSaving(false);
		}
	};
	return (
		<form onSubmit={submit} className="flex flex-col gap-3">
			<Field
				label="标题"
				value={title}
				maxLength={120}
				required
				onChange={(e) => setTitle(e.target.value)}
			/>
			<TextAreaField
				label="正文"
				value={body}
				rows={5}
				maxLength={8000}
				onChange={(e) => setBody(e.target.value)}
			/>
			<div className="flex items-center gap-2">
				<Switch checked={shared} onChange={setShared} label={SHARE_LABEL} />
				<span className="text-13 text-ink">{SHARE_LABEL}</span>
			</div>
			<p className="text-12 text-muted">
				不公开时只有部门成员看得到；部门的分身替成员办事时才会引用。
			</p>
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button
					type="submit"
					variant="primary"
					disabled={saving || !title.trim()}
				>
					{saving ? "保存中…" : submitLabel}
				</Button>
				<Button onClick={onCancel} disabled={saving}>
					取消
				</Button>
			</div>
		</form>
	);
}

function NoteCard({
	unitId,
	note,
	map,
	canManage,
	onChanged,
}: {
	unitId: string;
	note: Note;
	map: PrincipalMap;
	canManage: boolean;
	onChanged: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const author = map.get(note.authorId)?.displayName;
	if (editing)
		return (
			<section className="rounded-card border border-line bg-bg p-4">
				<NoteForm
					initial={{
						title: note.title,
						body: note.body,
						visibility: note.visibility === "shared" ? "shared" : "unit",
					}}
					submitLabel="保存"
					onCancel={() => setEditing(false)}
					onSubmit={async (v) => {
						await api.updateUnitNote(unitId, note.id, v);
						setEditing(false);
						onChanged();
					}}
				/>
			</section>
		);
	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.deleteUnitNote(unitId, note.id);
			onChanged();
		} catch (e) {
			setError(errorText(e));
			setBusy(false);
		}
	};
	return (
		<section className="rounded-card border border-line bg-bg p-4">
			<h3 className="text-14 font-semibold break-words text-ink">
				{note.title}
			</h3>
			<div className="mt-1 flex flex-wrap items-center gap-2">
				<Tag>{note.visibility === "shared" ? "全员可见" : "仅部门成员"}</Tag>
				{author ? <Tag>{`${author}写的`}</Tag> : null}
				<span className="text-12 text-muted">
					{formatListTime(note.updatedAt)}
				</span>
			</div>
			{note.body ? (
				<p className="mt-2 line-clamp-6 text-14 whitespace-pre-wrap break-words text-ink">
					{note.body}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="mt-2 text-12 text-danger">
					{error}
				</p>
			) : null}
			{canManage ? (
				<div className="mt-3 flex gap-2">
					<Button disabled={busy} onClick={() => setEditing(true)}>
						编辑
					</Button>
					<Button variant="danger" disabled={busy} onClick={remove}>
						删除
					</Button>
				</div>
			) : null}
		</section>
	);
}

/** 单元资料：成员看得到全部并可以新增；负责人管理；非成员只看得到公开的。 */
export function UnitNotes({
	detail,
	map,
	onChanged,
}: {
	detail: UnitDetailResponse;
	map: PrincipalMap;
	onChanged: () => void;
}) {
	const [creating, setCreating] = useState(false);
	const unitId = detail.unit.unit.id;
	const isMember = detail.myRole !== null;
	const canManage = detail.myRole === "head";
	return (
		<div className="flex flex-col gap-3">
			{creating ? (
				<section className="rounded-card border border-line bg-bg p-4">
					<h2 className="mb-3 text-16 font-semibold text-ink">新增部门资料</h2>
					<NoteForm
						initial={{ title: "", body: "", visibility: "unit" }}
						submitLabel="新增"
						onCancel={() => setCreating(false)}
						onSubmit={async (v) => {
							await api.createUnitNote(unitId, v);
							setCreating(false);
							onChanged();
						}}
					/>
				</section>
			) : isMember && detail.notes.length > 0 ? (
				<div>
					<Button variant="primary" onClick={() => setCreating(true)}>
						新增部门资料
					</Button>
				</div>
			) : null}
			{detail.notes.length === 0 && !creating ? (
				<EmptyState
					mascotId={detail.unit.twin.id}
					text={
						isMember
							? "部门还没有资料。写下排期、口径、流程这类常被问到的内容，部门的分身就能据此答复。"
							: "这个部门还没有对全员公开的资料。"
					}
					action={
						isMember
							? { label: "新增部门资料", onClick: () => setCreating(true) }
							: undefined
					}
				/>
			) : null}
			{detail.notes.map((note) => (
				<NoteCard
					key={note.id}
					unitId={unitId}
					note={note}
					map={map}
					canManage={canManage}
					onChanged={onChanged}
				/>
			))}
		</div>
	);
}
