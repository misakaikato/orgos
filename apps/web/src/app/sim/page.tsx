"use client";

import type { DemoPerson, DevInfoResponse } from "@orgos/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheck } from "@/components/icons";
import { Mascot } from "@/components/mascot";
import { ScriptPanel } from "@/components/sim/script-panel";
import { type PaneSession, SimPane } from "@/components/sim/sim-pane";
import { ThemeToggle } from "@/components/theme";
import { PersonAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { api, devApi } from "@/lib/api";
import { cx } from "@/lib/cx";
import { useMediaQuery } from "@/lib/hooks";

const DEFAULT_SELECTED = ["linxiao", "zhouye", "xunuo"];
const MAX_PANES = 4;
const PENDING_POLL_MS = 15_000;

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : "未知错误";
}

function ModelBadge({ info }: { info: DevInfoResponse | null }) {
	if (!info) return null;
	return (
		<span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-pill bg-surface-2 px-2.5 text-12 text-muted">
			<span
				aria-hidden="true"
				className={cx(
					"size-1.5 rounded-pill",
					info.modelMode === "real" ? "bg-good" : "bg-pending",
				)}
			/>
			{info.modelMode === "real" ? `真实模型 ${info.model}` : "假模型"}
		</span>
	);
}

/** 宽屏：勾选 1–4 人，至少保留一人。 */
function PeoplePicker({
	people,
	selected,
	onToggle,
}: {
	people: DemoPerson[];
	selected: string[];
	onToggle: (handle: string) => void;
}) {
	return (
		<fieldset className="flex flex-wrap items-center gap-2">
			<legend className="sr-only">选择要扮演的人物</legend>
			{people.map((p) => {
				const on = selected.includes(p.handle);
				const locked = on && selected.length === 1;
				return (
					<button
						key={p.handle}
						type="button"
						aria-pressed={on}
						disabled={locked || (!on && selected.length >= MAX_PANES)}
						title={
							locked ? "至少保留一个人物" : `${p.displayName} · ${p.title}`
						}
						onClick={() => onToggle(p.handle)}
						className={cx(
							"inline-flex h-8 items-center gap-1.5 rounded-pill pr-3 pl-1 text-13 transition-colors duration-150 disabled:cursor-not-allowed",
							on
								? "bg-accent-soft font-medium text-accent"
								: "bg-surface-2 text-muted hover:text-ink",
						)}
					>
						<PersonAvatar principal={p} size={24} />
						{p.displayName}
						{on ? <IconCheck size={14} /> : null}
					</button>
				);
			})}
		</fieldset>
	);
}

/** 窄屏：单人物，顶部分段切换。 */
function PeopleTabs({
	people,
	focused,
	onFocus,
}: {
	people: DemoPerson[];
	focused: string;
	onFocus: (handle: string) => void;
}) {
	return (
		<div
			role="tablist"
			aria-label="切换人物"
			className="flex items-center gap-1 overflow-x-auto rounded-pill bg-surface-2 p-1"
		>
			{people.map((p) => (
				<button
					key={p.handle}
					type="button"
					role="tab"
					aria-selected={p.handle === focused}
					onClick={() => onFocus(p.handle)}
					className={cx(
						"inline-flex h-8 flex-1 items-center justify-center rounded-pill px-3 text-13 whitespace-nowrap transition-colors duration-150",
						p.handle === focused
							? "bg-bg font-medium text-ink shadow-card-hover"
							: "text-muted hover:text-ink",
					)}
				>
					{p.displayName}
				</button>
			))}
		</div>
	);
}

/** 模拟台：一个浏览器里同时以多位演示人物登录（仅 ORGOS_DEV=1）。 */
export default function SimPage() {
	const wide = useMediaQuery("(min-width: 768px)");
	const [people, setPeople] = useState<DemoPerson[] | null>(null);
	const [info, setInfo] = useState<DevInfoResponse | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>(DEFAULT_SELECTED);
	const [focused, setFocused] = useState<string>(DEFAULT_SELECTED[0] ?? "");
	const [sessions, setSessions] = useState<Record<string, PaneSession>>({});
	const [resetting, setResetting] = useState(false);
	const [resetError, setResetError] = useState<string | null>(null);
	const [scriptChoice, setScriptChoice] = useState<boolean | null>(null);
	const inflight = useRef(new Set<string>());
	const generation = useRef(0);

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const [list, devInfo] = await Promise.all([
				devApi.people(),
				devApi.info(),
			]);
			setPeople(list.people);
			setInfo(devInfo);
		} catch (e) {
			setLoadError(messageOf(e));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const ordered = (people ?? []).filter((p) =>
		wide ? selected.includes(p.handle) : p.handle === focused,
	);
	const visibleKey = ordered.map((p) => p.handle).join(",");

	// 为可见的人物各取一个会话 token（每次重置后重新取）。
	useEffect(() => {
		const gen = generation.current;
		for (const handle of visibleKey ? visibleKey.split(",") : []) {
			if (sessions[handle] || inflight.current.has(handle)) continue;
			inflight.current.add(handle);
			setSessions((s) => ({ ...s, [handle]: { status: "loading" } }));
			devApi
				.session(handle)
				.then(({ token, principal }) => {
					if (gen !== generation.current) return;
					setSessions((s) => ({
						...s,
						[handle]: { status: "ready", token, principal, pending: null },
					}));
				})
				.catch((e: unknown) => {
					if (gen !== generation.current) return;
					setSessions((s) => ({
						...s,
						[handle]: { status: "error", message: messageOf(e) },
					}));
				})
				.finally(() => inflight.current.delete(handle));
		}
	}, [visibleKey, sessions]);

	// 列头的待办数：以各自身份读，定时刷新。
	const tokensKey = Object.entries(sessions)
		.flatMap(([h, s]) => (s.status === "ready" ? [`${h}:${s.token}`] : []))
		.join(",");
	useEffect(() => {
		if (!tokensKey) return;
		const pairs = tokensKey.split(",").map((x) => {
			const i = x.indexOf(":");
			return [x.slice(0, i), x.slice(i + 1)] as const;
		});
		const refresh = () => {
			for (const [handle, token] of pairs) {
				api
					.workItems("open", token)
					.then(({ items }) =>
						setSessions((s) => {
							const cur = s[handle];
							if (cur?.status !== "ready" || cur.token !== token) return s;
							return { ...s, [handle]: { ...cur, pending: items.length } };
						}),
					)
					.catch(() => {});
			}
		};
		refresh();
		const timer = setInterval(refresh, PENDING_POLL_MS);
		return () => clearInterval(timer);
	}, [tokensKey]);

	const reset = async () => {
		setResetting(true);
		setResetError(null);
		try {
			await devApi.resetDemo();
			generation.current += 1;
			inflight.current.clear();
			setSessions({});
		} catch (e) {
			setResetError(`重置失败：${messageOf(e)}`);
		} finally {
			setResetting(false);
		}
	};

	const toggle = (handle: string) =>
		setSelected((cur) =>
			cur.includes(handle)
				? cur.filter((h) => h !== handle)
				: [...cur, handle].slice(0, MAX_PANES),
		);

	const retry = (handle: string) =>
		setSessions((s) => {
			const { [handle]: _, ...rest } = s;
			return rest;
		});

	const scriptOpen = scriptChoice ?? wide;
	const mockMode = info?.modelMode !== "real";

	if (loadError) {
		return (
			<div className="flex h-dvh items-center justify-center bg-bg">
				<ErrorState text={`模拟台加载失败：${loadError}`} onRetry={load} />
			</div>
		);
	}
	if (!people) {
		return (
			<div className="h-dvh bg-sidebar">
				<LoadingRows rows={4} />
			</div>
		);
	}

	return (
		<div className="flex h-dvh flex-col overflow-hidden bg-sidebar text-ink">
			<header className="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-1">
				<div className="flex flex-wrap items-center gap-3">
					<h1 className="flex items-center gap-2 text-16 font-semibold text-ink">
						<Mascot id="orgos" size={28} />
						模拟台
					</h1>
					{wide ? (
						<PeoplePicker
							people={people}
							selected={selected}
							onToggle={toggle}
						/>
					) : null}
					<span className="ml-auto flex items-center gap-2">
						<ModelBadge info={info} />
						<Button disabled={resetting} onClick={() => void reset()}>
							{resetting ? "重置中…" : "重置演示数据"}
						</Button>
						<Button
							variant="ghost"
							aria-pressed={scriptOpen}
							onClick={() => setScriptChoice(!scriptOpen)}
						>
							剧本
						</Button>
						<ThemeToggle />
					</span>
				</div>
				{wide ? null : (
					<PeopleTabs people={people} focused={focused} onFocus={setFocused} />
				)}
				{resetError ? (
					<p role="alert" className="text-12 text-danger">
						{resetError}
					</p>
				) : null}
			</header>
			<div className="flex min-h-0 flex-1 gap-3 p-3">
				<div
					className="grid min-h-0 min-w-0 flex-1 gap-3"
					style={{
						gridTemplateColumns: `repeat(${Math.max(ordered.length, 1)}, minmax(0, 1fr))`,
					}}
				>
					{ordered.map((p) => (
						<SimPane
							key={p.handle}
							person={p}
							session={sessions[p.handle]}
							onRetry={() => retry(p.handle)}
						/>
					))}
				</div>
				{scriptOpen ? (
					<ScriptPanel
						people={people}
						mockMode={mockMode}
						onClose={() => setScriptChoice(false)}
						className={
							wide
								? "w-inspector shrink-0 overflow-hidden rounded-card shadow-float"
								: "fixed inset-0 z-10"
						}
					/>
				) : null}
			</div>
		</div>
	);
}
