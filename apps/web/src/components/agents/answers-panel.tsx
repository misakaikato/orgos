"use client";

import type {
	DisclosureRule,
	MemoryCategory,
	MemoryStatus,
	MessageCitation,
	TwinAnswer,
} from "@orgos/protocol";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
	CategorySelect,
	errorText,
	useMemoryUnit,
} from "@/components/agents/memory-shared";
import { messageHref } from "@/components/conversation/citations";
import { AgentName } from "@/components/conversation/message-item";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { formatListTime } from "@/lib/format";
import { usePrincipalMap } from "@/lib/hooks";
import type { PrincipalMap } from "@/lib/principals";
import { useStore } from "@/lib/store";

const STATUS_TAG: Partial<Record<MemoryStatus, string>> = {
	superseded: "已被取代",
	retracted: "已撤回",
};

type Mode = "idle" | "correct" | "withhold";

function citationsOf(item: TwinAnswer): MessageCitation[] {
	return item.answer.type === "message.posted"
		? (item.answer.payload.citations ?? [])
		: [];
}

function CorrectForm({
	answer,
	onDone,
	onCancel,
}: {
	answer: TwinAnswer;
	onDone: () => void;
	onCancel: () => void;
}) {
	const replaceable = citationsOf(answer).filter(
		(c) =>
			answer.ownCited?.includes(c.id) && answer.citedStatus[c.id] === "active",
	);
	const [text, setText] = useState("");
	const [replaces, setReplaces] = useState<string[]>(
		replaceable.map((c) => c.id),
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const unitId = useMemoryUnit();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			await api.correctAnswer(answer.answer.id, { text, replaces }, unitId);
			onDone();
		} catch (err) {
			setError(errorText(err));
			setSaving(false);
		}
	};
	return (
		<form
			onSubmit={submit}
			className="mt-3 flex flex-col gap-3 rounded-row bg-surface-2 p-3"
		>
			<TextAreaField
				label="正确的说法"
				value={text}
				rows={2}
				maxLength={500}
				required
				onChange={(e) => setText(e.target.value)}
				hint="记为你本人的更正，分身以后优先用它。"
			/>
			{replaceable.length > 0 ? (
				<fieldset className="flex flex-col gap-1.5">
					<legend className="mb-1 text-13 font-medium text-ink">
						这条更正取代哪些记忆
					</legend>
					{replaceable.map((c) => (
						<label
							key={c.id}
							className="flex items-start gap-2 text-13 break-words text-ink"
						>
							<input
								type="checkbox"
								className="mt-1 size-4 shrink-0 accent-accent"
								checked={replaces.includes(c.id)}
								onChange={(e) =>
									setReplaces((list) =>
										e.target.checked
											? [...list, c.id]
											: list.filter((id) => id !== c.id),
									)
								}
							/>
							<span className="min-w-0">{c.content}</span>
						</label>
					))}
				</fieldset>
			) : null}
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button
					type="submit"
					variant="primary"
					disabled={saving || !text.trim()}
				>
					{saving ? "保存中…" : "提交更正"}
				</Button>
				<Button onClick={onCancel} disabled={saving}>
					取消
				</Button>
			</div>
		</form>
	);
}

function WithholdForm({
	answer,
	hidden,
	onDone,
	onCancel,
}: {
	answer: TwinAnswer;
	/** 本人目前不对外的类别。 */
	hidden: MemoryCategory[];
	onDone: () => void;
	onCancel: () => void;
}) {
	const [category, setCategory] = useState<MemoryCategory | null>(
		hidden[0] ?? null,
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const unitId = useMemoryUnit();
	const act = async (req: Parameters<typeof api.withholdAnswer>[1]) => {
		setBusy(true);
		setError(null);
		try {
			await api.withholdAnswer(answer.answer.id, req, unitId);
			onDone();
		} catch (e) {
			setError(errorText(e));
			setBusy(false);
		}
	};
	return (
		<div className="mt-3 flex flex-col gap-3 rounded-row bg-surface-2 p-3">
			<p className="text-13 text-ink">
				这次回答引用的你的记忆，以后不再对外说。可以直接撤回，或改成一个不对外的类别（自己仍能用）。
			</p>
			{category ? (
				<CategorySelect
					label="改为类别"
					value={category}
					onChange={setCategory}
					only={hidden}
					disabled={busy}
				/>
			) : null}
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				{category ? (
					<Button
						variant="primary"
						disabled={busy}
						onClick={() => void act({ mode: "category", category })}
					>
						改类别
					</Button>
				) : null}
				<Button
					variant="danger"
					disabled={busy}
					onClick={() => void act({ mode: "retract" })}
				>
					撤回
				</Button>
				<Button onClick={onCancel} disabled={busy}>
					取消
				</Button>
			</div>
		</div>
	);
}

function AnswerCard({
	item,
	map,
	meId,
	hidden,
	onChanged,
}: {
	item: TwinAnswer;
	map: PrincipalMap;
	meId: string;
	hidden: MemoryCategory[];
	onChanged: () => void;
}) {
	const router = useRouter();
	const [mode, setMode] = useState<Mode>("idle");
	const asker = map.get(item.askedById);
	const agent = map.get(item.answer.actorId);
	const citations = citationsOf(item);
	const text =
		item.answer.type === "message.posted" ? item.answer.payload.text : "";
	const question =
		item.question?.type === "message.posted"
			? item.question.payload.text
			: null;
	const seq = item.answer.seq;
	const topicId = item.answer.topicId;
	const done = () => {
		setMode("idle");
		onChanged();
	};

	return (
		<section className="rounded-card border border-line bg-bg p-4">
			<div className="flex items-start gap-3">
				{asker ? <Avatar principal={asker} size={32} /> : null}
				<div className="min-w-0 flex-1">
					<p className="text-13 text-muted">
						<span className="font-semibold text-ink">
							{asker?.displayName ?? "同事"}
						</span>{" "}
						问 · {formatListTime(item.answer.createdAt)}
					</p>
					<p className="mt-1 text-14 break-words text-ink">
						{question ?? "（你答复了转交的问题，分身转告了对方）"}
					</p>
				</div>
				{item.handled ? (
					<Tag tone="good">
						{item.handled === "corrected" ? "已更正" : "已不对外"}
					</Tag>
				) : null}
			</div>
			<div className="mt-3 rounded-bubble border border-line px-3.5 py-2.5">
				{agent ? (
					<div className="mb-1">
						<AgentName agent={agent} map={map} meId={meId} />
					</div>
				) : null}
				<p className="text-14 whitespace-pre-wrap break-words text-ink">
					{text}
				</p>
			</div>
			<div className="mt-3">
				<p className="text-12 font-medium text-muted">
					{citations.length > 0 ? "依据" : "这次回答没有引用记忆"}
				</p>
				{citations.length > 0 ? (
					<ul className="mt-1 flex flex-col gap-1">
						{citations.map((c) => {
							const status = item.citedStatus[c.id];
							const tag = status ? STATUS_TAG[status] : undefined;
							return (
								<li
									key={c.id}
									className="flex items-start gap-2 text-13 break-words text-ink"
								>
									<span className="min-w-0 flex-1">{c.content}</span>
									{tag ? <Tag>{tag}</Tag> : null}
								</li>
							);
						})}
					</ul>
				) : null}
			</div>
			{mode === "correct" ? (
				<CorrectForm
					answer={item}
					onDone={done}
					onCancel={() => setMode("idle")}
				/>
			) : mode === "withhold" ? (
				<WithholdForm
					answer={item}
					hidden={hidden}
					onDone={done}
					onCancel={() => setMode("idle")}
				/>
			) : (
				<div className="mt-3 flex flex-wrap gap-2">
					<Button onClick={() => setMode("correct")}>不对</Button>
					{citations.length > 0 ? (
						<Button variant="danger" onClick={() => setMode("withhold")}>
							不许对外说
						</Button>
					) : null}
					{seq !== null && topicId ? (
						<Button
							variant="ghost"
							onClick={() =>
								router.push(
									messageHref({
										conversationId: item.conversationId,
										topicId,
										seq,
										label: "",
									}),
								)
							}
						>
							查看对话
						</Button>
					) : null}
				</div>
			)}
		</section>
	);
}

/** 代答记录：分身替我对他人的每一次回答——谁问的、答了什么、用了哪些依据；可更正或收回。 */
export function AnswersPanel() {
	const map = usePrincipalMap();
	const meId = useStore((s) => s.me?.principal.id ?? "");
	const [items, setItems] = useState<TwinAnswer[] | null>(null);
	const [rules, setRules] = useState<DisclosureRule[]>([]);
	const [failed, setFailed] = useState(false);
	const unitId = useMemoryUnit();

	const load = useCallback(async () => {
		setFailed(false);
		try {
			const [answers, disclosure] = await Promise.all([
				api.twinAnswers(unitId),
				api.disclosure(unitId),
			]);
			setItems(answers.items);
			setRules(disclosure.rules);
		} catch {
			setFailed(true);
		}
	}, [unitId]);

	useEffect(() => {
		void load();
	}, [load]);

	if (failed) return <ErrorState text="代答记录加载失败。" onRetry={load} />;
	if (!items) return <LoadingRows rows={3} />;
	const hidden = rules.filter((r) => !r.allowed).map((r) => r.category);
	return (
		<div className="flex flex-col gap-3">
			<p className="text-13 text-muted">
				{unitId
					? "部门的分身替部门回答同事的每一次记录在这里。答错了点“不对”写下正确说法；不该说的点“不许对外说”。"
					: "分身替你回答同事的每一次记录在这里。答错了点“不对”写下正确说法；不该说的点“不许对外说”。"}
			</p>
			{items.length === 0 ? (
				<EmptyState
					mascotId="orgos-answers-empty"
					text={
						unitId
							? "部门的分身还没有回答过别人。同事来“问部门”时，它的回答会出现在这里。"
							: "分身还没有替你回答过别人。同事在私聊里问你的分身、或你忙碌时，它的回答会出现在这里。"
					}
				/>
			) : (
				items.map((item) => (
					<AnswerCard
						key={item.answer.id}
						item={item}
						map={map}
						meId={meId}
						hidden={hidden}
						onChanged={() => void load()}
					/>
				))
			)}
		</div>
	);
}
