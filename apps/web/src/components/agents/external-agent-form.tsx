"use client";

import {
	AGENT_ACP_CAPABILITY,
	type Agent,
	findAdapter,
	HANDLE_RE,
	type Runner,
} from "@orgos/protocol";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";

/** 设备上报的、当前可用的适配器。 */
export function availableAdapters(runner: Runner | undefined): string[] {
	const acp = runner?.capabilities.find((c) => c.name === AGENT_ACP_CAPABILITY);
	return (acp?.adapters ?? []).filter((a) => a.available).map((a) => a.id);
}

function adapterLabel(id: string): string {
	return findAdapter(id)?.label ?? id;
}

function defaultHandle(ownerHandle: string, adapter: string): string {
	return `${ownerHandle}-${adapter}`.slice(0, 31);
}

const SELECT =
	"h-control w-full rounded-pill bg-surface-2 px-3 text-14 text-ink outline-none focus:ring-2 focus:ring-accent disabled:opacity-50";

/**
 * 接入外部助手：选设备（只列在线且上报了 agent.acp 的）、适配器（只列该设备探测可用的）、
 * 工作目录（在设备工作目录之内）、名字与 handle。建好后它出现在代理组与会话列表里。
 */
export function ExternalAgentForm({
	ownerHandle,
	onCreated,
	onCancel,
}: {
	ownerHandle: string;
	onCreated: (agent: Agent) => void;
	onCancel: () => void;
}) {
	const ids = useId();
	const runners = useStore((s) => s.runners);
	const usable = (runners ?? []).filter(
		(r) => r.status === "online" && availableAdapters(r).length > 0,
	);
	const [runnerId, setRunnerId] = useState(usable[0]?.id ?? "");
	const runner = usable.find((r) => r.id === runnerId) ?? usable[0];
	const adapters = availableAdapters(runner);
	const [adapter, setAdapter] = useState(adapters[0] ?? "");
	const chosen = adapters.includes(adapter) ? adapter : (adapters[0] ?? "");
	const [workspace, setWorkspace] = useState(runner?.workspace ?? "");
	const [displayName, setDisplayName] = useState(
		chosen ? adapterLabel(chosen) : "",
	);
	const [handle, setHandle] = useState(
		chosen ? defaultHandle(ownerHandle, chosen) : `${ownerHandle}-`,
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const handleOk = HANDLE_RE.test(handle);
	const note = chosen ? findAdapter(chosen)?.note : undefined;

	const pickRunner = (id: string) => {
		setRunnerId(id);
		const next = usable.find((r) => r.id === id);
		setWorkspace(next?.workspace ?? "");
		const first = availableAdapters(next)[0] ?? "";
		pickAdapter(first);
	};
	const pickAdapter = (id: string) => {
		setAdapter(id);
		if (!id) return;
		setDisplayName(adapterLabel(id));
		setHandle(defaultHandle(ownerHandle, id));
	};
	// 设备列表晚于表单到达时，按第一台可用设备补上默认值。
	const firstId = runner?.id;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在可用设备首次出现时补默认值。
	useEffect(() => {
		if (firstId && !runnerId) pickRunner(firstId);
	}, [firstId]);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!runner || !chosen || !handleOk) return;
		setSaving(true);
		setError(null);
		try {
			const { agent } = await api.createAgent({
				kind: "external",
				displayName,
				handle,
				adapter: chosen,
				runnerId: runner.id,
				workspace,
			});
			onCreated(agent);
		} catch (err) {
			setError(err instanceof Error ? err.message : "接入失败");
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			onSubmit={submit}
			className="flex flex-col gap-3 rounded-card border border-line bg-bg p-4"
		>
			<h2 className="text-16 font-semibold text-ink">接入外部助手</h2>
			<p className="text-13 text-muted">
				把本机的 Claude Code、Codex
				等接成你的助手：它只替你干活，在你的设备上、限定的工作目录里做事，用的是你自己在那台设备上的登录。
			</p>
			{usable.length === 0 ? (
				<p className="rounded-row bg-surface-2 px-3 py-2 text-14 text-muted">
					{runners === null
						? "正在读取设备…"
						: "还没有在线、且能运行外部助手的设备。先到「设备」页添加设备并启动 Runner，等它探测完本机的助手。"}
				</p>
			) : (
				<>
					<div className="flex flex-col gap-1.5">
						<label
							htmlFor={`${ids}-runner`}
							className="text-13 font-medium text-ink"
						>
							设备
						</label>
						<select
							id={`${ids}-runner`}
							value={runner?.id ?? ""}
							onChange={(e) => pickRunner(e.target.value)}
							className={SELECT}
						>
							{usable.map((r) => (
								<option key={r.id} value={r.id}>
									{r.name}
								</option>
							))}
						</select>
					</div>
					<div className="flex flex-col gap-1.5">
						<label
							htmlFor={`${ids}-adapter`}
							className="text-13 font-medium text-ink"
						>
							哪个助手
						</label>
						<select
							id={`${ids}-adapter`}
							value={chosen}
							onChange={(e) => pickAdapter(e.target.value)}
							className={SELECT}
						>
							{adapters.map((id) => (
								<option key={id} value={id}>
									{adapterLabel(id)}
								</option>
							))}
						</select>
						{note ? <p className="text-12 text-muted">{note}</p> : null}
					</div>
					<Field
						label="工作目录"
						value={workspace}
						required
						hint="它只能在这个目录里读写文件、执行命令；必须在设备的工作目录之内。"
						onChange={(e) => setWorkspace(e.target.value)}
					/>
					<Field
						label="名字"
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
						onChange={(e) => setHandle(e.target.value.toLowerCase())}
					/>
				</>
			)}
			{error ? (
				<p role="alert" className="text-12 text-danger">
					{error}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button
					type="submit"
					variant="primary"
					disabled={
						saving ||
						!runner ||
						!chosen ||
						!handleOk ||
						!displayName.trim() ||
						!workspace.trim()
					}
				>
					{saving ? "接入中…" : "接入"}
				</Button>
				<Button onClick={onCancel} disabled={saving}>
					取消
				</Button>
			</div>
		</form>
	);
}
