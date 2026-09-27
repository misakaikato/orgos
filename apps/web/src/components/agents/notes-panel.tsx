"use client";

import type { Note, PERSONAL_NOTE_VISIBILITIES } from "@orgos/protocol";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Switch, TextAreaField } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { formatListTime } from "@/lib/format";
import { usePrincipalMap } from "@/lib/hooks";
import type { PrincipalMap } from "@/lib/principals";

const SHARE_LABEL = "共享给同事的分身";

/** 个人资料的表单结果（个人资料只有仅自己与共享两种）。 */
type NoteDraft = {
	title: string;
	body: string;
	visibility: (typeof PERSONAL_NOTE_VISIBILITIES)[number];
};

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : "操作失败";
}

function NoteForm({
	initial,
	submitLabel,
	onSubmit,
	onCancel,
}: {
	initial: Pick<Note, "title" | "body" | "visibility">;
	submitLabel: string;
	onSubmit: (v: NoteDraft) => Promise<void>;
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
			await onSubmit({
				title,
				body,
				visibility: shared ? "shared" : "private",
			});
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

function authorLabel(note: Note, map: PrincipalMap): string | null {
	if (note.authorId === note.ownerId) return null;
	const author = map.get(note.authorId);
	return `由${author?.displayName ?? "代理"}记下`;
}

function NoteCard({
	note,
	map,
	onChanged,
	onDeleted,
}: {
	note: Note;
	map: PrincipalMap;
	onChanged: (next: Note) => void;
	onDeleted: (id: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const author = authorLabel(note, map);

	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await fn();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	if (editing) {
		return (
			<section className="rounded-card border border-line bg-bg p-4">
				<NoteForm
					initial={note}
					submitLabel="保存"
					onCancel={() => setEditing(false)}
					onSubmit={async (v) => {
						const { note: next } = await api.updateNote(note.id, v);
						setEditing(false);
						onChanged(next);
					}}
				/>
			</section>
		);
	}

	return (
		<section className="rounded-card border border-line bg-bg p-4">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<h3 className="text-14 font-semibold break-words text-ink">
						{note.title}
					</h3>
					<div className="mt-1 flex flex-wrap items-center gap-2">
						{author ? <Tag>{author}</Tag> : null}
						<span className="text-12 text-muted">
							{formatListTime(note.updatedAt)}
						</span>
					</div>
				</div>
				<Switch
					checked={note.visibility === "shared"}
					label={SHARE_LABEL}
					disabled={busy}
					onChange={(next) =>
						void run(async () => {
							const { note: updated } = await api.updateNote(note.id, {
								visibility: next ? "shared" : "private",
							});
							onChanged(updated);
						})
					}
				/>
			</div>
			{note.body ? (
				<p className="mt-2 line-clamp-4 text-14 whitespace-pre-wrap break-words text-ink">
					{note.body}
				</p>
			) : null}
			<p className="mt-2 text-12 text-muted">
				{note.visibility === "shared"
					? "已共享：同事问你的分身时可以引用。"
					: "仅自己：只有你和替你办事的代理能看到。"}
			</p>
			{error ? (
				<p role="alert" className="mt-2 text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="mt-3 flex gap-2">
				<Button disabled={busy} onClick={() => setEditing(true)}>
					编辑
				</Button>
				<Button
					variant="danger"
					disabled={busy}
					onClick={() =>
						void run(async () => {
							await api.deleteNote(note.id);
							onDeleted(note.id);
						})
					}
				>
					删除
				</Button>
			</div>
		</section>
	);
}

/** 资料：本人写的资料与代理记下的记忆；共享开关决定别人的问题能不能引用。 */
export function NotesPanel() {
	const map = usePrincipalMap();
	const [notes, setNotes] = useState<Note[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [creating, setCreating] = useState(false);

	const load = useCallback(async () => {
		setFailed(false);
		try {
			setNotes((await api.notes()).items);
		} catch {
			setFailed(true);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const replace = (next: Note) =>
		setNotes((list) => list?.map((n) => (n.id === next.id ? next : n)) ?? null);
	const remove = (id: string) =>
		setNotes((list) => list?.filter((n) => n.id !== id) ?? null);

	if (failed) return <ErrorState text="资料加载失败。" onRetry={load} />;
	if (!notes) return <LoadingRows rows={3} />;

	return (
		<div className="flex flex-col gap-3">
			{creating ? (
				<section className="rounded-card border border-line bg-bg p-4">
					<h2 className="mb-3 text-16 font-semibold text-ink">新建资料</h2>
					<NoteForm
						initial={{ title: "", body: "", visibility: "private" }}
						submitLabel="新建"
						onCancel={() => setCreating(false)}
						onSubmit={async (v) => {
							const { note } = await api.createNote(v);
							setCreating(false);
							setNotes((list) => [note, ...(list ?? [])]);
						}}
					/>
				</section>
			) : notes.length > 0 ? (
				<div>
					<Button variant="primary" onClick={() => setCreating(true)}>
						新建资料
					</Button>
				</div>
			) : null}
			{notes.length === 0 && !creating ? (
				<EmptyState
					mascotId="orgos-notes-empty"
					text="还没有资料。写下路线图、口径这类常被问到的内容并设为共享，你的分身就能替你回答。"
					action={{ label: "新建资料", onClick: () => setCreating(true) }}
				/>
			) : null}
			{notes.map((note) => (
				<NoteCard
					key={note.id}
					note={note}
					map={map}
					onChanged={replace}
					onDeleted={remove}
				/>
			))}
		</div>
	);
}
