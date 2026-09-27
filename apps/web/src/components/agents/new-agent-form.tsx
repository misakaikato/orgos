"use client";

import { type Agent, HANDLE_RE } from "@orgos/protocol";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, TextAreaField } from "@/components/ui/input";
import { api } from "@/lib/api";

/** 新建一位助手：名字、handle、职责说明。 */
export function NewAgentForm({
	ownerHandle,
	onCreated,
	onCancel,
}: {
	ownerHandle: string;
	onCreated: (agent: Agent) => void;
	onCancel: () => void;
}) {
	const [displayName, setDisplayName] = useState("");
	const [handle, setHandle] = useState(`${ownerHandle}-`);
	const [description, setDescription] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const handleOk = HANDLE_RE.test(handle);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!handleOk) return;
		setSaving(true);
		setError(null);
		try {
			const { agent } = await api.createAgent({
				displayName,
				handle,
				description,
			});
			onCreated(agent);
		} catch (err) {
			setError(err instanceof Error ? err.message : "新建失败");
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			onSubmit={submit}
			className="flex flex-col gap-3 rounded-card border border-line bg-bg p-4"
		>
			<h2 className="text-16 font-semibold text-ink">新建助手</h2>
			<Field
				label="名字"
				placeholder="例如：写作助手"
				value={displayName}
				maxLength={40}
				required
				onChange={(e) => setDisplayName(e.target.value)}
			/>
			<Field
				label="handle"
				value={handle}
				maxLength={31}
				required
				error={
					handle && !handleOk
						? "小写字母开头，2–31 位小写字母、数字或连字符"
						: null
				}
				hint="在消息里用 @handle 叫它。"
				onChange={(e) => setHandle(e.target.value.toLowerCase())}
			/>
			<TextAreaField
				label="职责说明"
				placeholder="它负责什么、怎么做事、交回什么。"
				value={description}
				maxLength={2000}
				onChange={(e) => setDescription(e.target.value)}
			/>
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button
					type="submit"
					variant="primary"
					disabled={saving || !handleOk || !displayName.trim()}
				>
					{saving ? "新建中…" : "新建"}
				</Button>
				<Button onClick={onCancel} disabled={saving}>
					取消
				</Button>
			</div>
		</form>
	);
}
