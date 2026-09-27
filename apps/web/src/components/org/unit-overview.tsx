"use client";

import {
	CHARTER_MAX_LENGTH,
	type Note,
	UNIT_MEMBER_ROLE_LABEL,
	type UnitDetailResponse,
} from "@orgos/protocol";
import { useState } from "react";
import { errorText } from "@/components/agents/memory-shared";
import { Mascot } from "@/components/mascot";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/states";
import { api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { formatListTime } from "@/lib/format";

function Card({
	title,
	actions,
	children,
}: {
	title: string;
	actions?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="rounded-card border border-line bg-bg p-4">
			<div className="flex items-center gap-3">
				<h2 className="min-w-0 flex-1 text-14 font-semibold text-ink">
					{title}
				</h2>
				{actions}
			</div>
			<div className="mt-3">{children}</div>
		</section>
	);
}

/** 章程：所有人可读，负责人（与租户管理员）可编辑。 */
function CharterCard({
	detail,
	canEdit,
	onSaved,
}: {
	detail: UnitDetailResponse;
	canEdit: boolean;
	onSaved: () => void;
}) {
	const charter = detail.unit.charter ?? "";
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(charter);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			await api.updateUnit(detail.unit.unit.id, { charter: text });
			setEditing(false);
			onSaved();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setSaving(false);
		}
	};
	return (
		<Card
			title="章程"
			actions={
				canEdit && !editing ? (
					<Button
						onClick={() => {
							setText(charter);
							setEditing(true);
						}}
					>
						编辑
					</Button>
				) : null
			}
		>
			{editing ? (
				<div className="flex flex-col gap-3">
					<TextAreaField
						label="写给部门分身的政策"
						value={text}
						rows={6}
						maxLength={CHARTER_MAX_LENGTH}
						onChange={(e) => setText(e.target.value)}
						hint="章程允许的事分身直接答复或决定；章程之外的会转给负责人。"
					/>
					{error ? (
						<p role="alert" className="text-12 text-danger">
							{error}
						</p>
					) : null}
					<div className="flex gap-2">
						<Button variant="primary" disabled={saving} onClick={save}>
							{saving ? "保存中…" : "保存"}
						</Button>
						<Button disabled={saving} onClick={() => setEditing(false)}>
							取消
						</Button>
					</div>
				</div>
			) : (
				<p
					className={cx(
						"text-14 whitespace-pre-wrap break-words",
						charter ? "text-ink" : "text-muted",
					)}
				>
					{charter ||
						"还没写。没写时部门的分身只回答单元资料里明确写着的内容，其余都转给负责人。"}
				</p>
			)}
		</Card>
	);
}

function DecisionRow({ note }: { note: Note }) {
	return (
		<li className="py-3 first:pt-0 last:pb-0">
			<div className="flex items-baseline gap-2">
				<span className="min-w-0 flex-1 text-14 font-semibold break-words text-ink">
					{note.title}
				</span>
				<span className="shrink-0 text-12 text-muted">
					{formatListTime(note.createdAt)}
				</span>
			</div>
			<p className="mt-1 text-13 whitespace-pre-wrap break-words text-muted">
				{note.body}
			</p>
		</li>
	);
}

/** 单元页"概况"：负责人与成员、章程、单元分身最近记下的决定。 */
export function UnitOverview({
	detail,
	meId,
	onChanged,
}: {
	detail: UnitDetailResponse;
	meId: string;
	onChanged: () => void;
}) {
	const { unit } = detail;
	const canEditCharter = detail.myRole === "head" || detail.canAdminister;
	return (
		<div className="flex flex-col gap-3">
			<Card title={`成员 ${unit.members.length}`}>
				<ul className="flex flex-col gap-3">
					{unit.members.map((m) => (
						<li key={m.principal.id} className="flex items-center gap-3">
							<Avatar principal={m.principal} size={32} showStatus />
							<span className="min-w-0 flex-1 truncate text-14 text-ink">
								{m.principal.displayName}
								{m.principal.id === meId ? (
									<span className="ml-1 text-12 text-muted">（你）</span>
								) : null}
							</span>
							<Tag>{UNIT_MEMBER_ROLE_LABEL[m.role]}</Tag>
						</li>
					))}
				</ul>
				<div className="mt-4 flex items-center gap-3 border-t border-line pt-3">
					<Mascot id={unit.twin.id} size={32} />
					<span className="min-w-0 flex-1 text-13 text-muted">
						{unit.twin.displayName}：按章程替{unit.unit.displayName}
						答复与决定，章程之外转给{unit.head.displayName}。
					</span>
				</div>
			</Card>
			<CharterCard
				detail={detail}
				canEdit={canEditCharter}
				onSaved={onChanged}
			/>
			<Card title="部门分身最近的决定">
				{detail.decisions.length === 0 ? (
					<EmptyState
						compact
						mascotId={unit.twin.id}
						text={
							detail.myRole
								? "部门的分身还没有按章程做过决定。"
								: "部门的决定只对成员可见。"
						}
					/>
				) : (
					<ul className="divide-y divide-line">
						{detail.decisions.map((n) => (
							<DecisionRow key={n.id} note={n} />
						))}
					</ul>
				)}
			</Card>
		</div>
	);
}
