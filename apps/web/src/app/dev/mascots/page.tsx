"use client";

import { defaultAssistantName, twinName } from "@orgos/protocol";
import { useEffect, useState } from "react";
import { WorkingIndicator } from "@/components/conversation/working-indicator";
import {
	Mascot,
	type MascotState,
	mascotInkClass,
	toneInkClass,
} from "@/components/mascot";
import { ThemeToggle } from "@/components/theme";
import { cx } from "@/lib/cx";
import { MASCOT_ART_COUNT, mascotArt, mascotArtAt } from "@/lib/principals";

/** 24 个随机示例 id：与真实代理 id 一样走哈希；每次打开页面换一批。 */
function randomIds(): string[] {
	return Array.from({ length: 24 }, () => crypto.randomUUID());
}

const ARTS = Array.from({ length: MASCOT_ART_COUNT }, (_, i) =>
	mascotArtAt(i + 1),
);

const STATES: { key: MascotState; label: string }[] = [
	{ key: "idle", label: "待命" },
	{ key: "working", label: "工作中" },
	{ key: "done", label: "完成" },
];

const SIZES = [72, 40, 32, 28, 24];
const SAMPLE_ID = "demo-agent-sizes";

/** 开发用：12 张团子、随机 id 的分配、状态与尺寸预览（仅 ORGOS_DEV=1，由服务端守卫）。 */
export default function MascotsPage() {
	const [state, setState] = useState<MascotState>("idle");
	// 每次点"完成"都重新挂载，让回弹再播一遍。
	const [replay, setReplay] = useState(0);
	const [ids, setIds] = useState<string[]>([]);
	// 随机 id 只在客户端生成，避免与服务端渲染不一致。
	useEffect(() => setIds(randomIds()), []);
	return (
		<div className="min-h-dvh bg-sidebar text-ink">
			<header className="flex flex-wrap items-center gap-3 px-4 py-3 md:px-6">
				<h1 className="text-16 font-semibold">团子预览</h1>
				<div
					role="toolbar"
					aria-label="状态"
					className="flex gap-1 rounded-pill bg-surface-2 p-1"
				>
					{STATES.map((s) => (
						<button
							key={s.key}
							type="button"
							aria-pressed={state === s.key}
							onClick={() => {
								setState(s.key);
								if (s.key === "done") setReplay((n) => n + 1);
							}}
							className={cx(
								"h-7 rounded-pill px-3 text-13 transition-colors duration-150",
								state === s.key
									? "bg-bg font-medium text-ink shadow-card-hover"
									: "text-muted hover:text-ink",
							)}
						>
							{s.label}
						</button>
					))}
				</div>
				<span className="ml-auto">
					<ThemeToggle />
				</span>
			</header>
			<main className="flex flex-col gap-4 px-4 pb-10 md:px-6">
				<section className="rounded-card bg-bg p-4 md:p-6">
					<h2 className="text-14 font-semibold">全部插画</h2>
					<p className="mt-1 text-12 text-muted">12 张，每张对应一个名字色</p>
					<ul className="mt-4 grid grid-cols-3 gap-x-2 gap-y-6 sm:grid-cols-4 md:grid-cols-6">
						{ARTS.map((art) => (
							<li
								key={art.index}
								className="flex flex-col items-center gap-1.5 text-center"
							>
								{/* biome-ignore lint/performance/noImgElement: 与 Mascot 同一张静态图。 */}
								<img
									src={art.src}
									width={72}
									height={72}
									alt=""
									className="select-none"
								/>
								<span className="text-12 text-muted">{`m${String(art.index).padStart(2, "0")}`}</span>
								<span
									className={cx(
										"text-12 font-semibold",
										toneInkClass(art.tone),
									)}
								>
									{`团子色 ${art.tone}`}
								</span>
							</li>
						))}
					</ul>
				</section>
				<section className="rounded-card bg-bg p-4 md:p-6">
					<div className="flex flex-wrap items-center gap-3">
						<h2 className="text-14 font-semibold">随机 id 的分配</h2>
						<button
							type="button"
							onClick={() => setIds(randomIds())}
							className="ml-auto h-8 rounded-pill bg-surface-2 px-3 text-13 text-ink"
						>
							换一批
						</button>
					</div>
					<ul className="mt-4 grid grid-cols-3 gap-x-2 gap-y-6 sm:grid-cols-4 md:grid-cols-6">
						{ids.map((id) => (
							<li
								key={id}
								className="flex flex-col items-center gap-1.5 text-center"
							>
								<Mascot
									key={`${id}-${replay}`}
									id={id}
									size={72}
									state={state}
									label={id.slice(0, 8)}
								/>
								<span
									className={cx("text-12 font-semibold", mascotInkClass(id))}
								>
									{id.slice(0, 8)}
								</span>
								<span className="text-12 text-muted">
									{`m${String(mascotArt(id).index).padStart(2, "0")}`}
								</span>
							</li>
						))}
					</ul>
				</section>
				<div className="grid gap-4 md:grid-cols-2">
					<section className="rounded-card bg-bg p-4 md:p-6">
						<h2 className="text-14 font-semibold">尺寸</h2>
						<p className="mt-1 text-12 text-muted">
							检查器与空状态 72、列表 40、气泡旁 32、会话标题 28、行内 24
						</p>
						<div className="mt-4 flex items-end gap-6">
							{SIZES.map((size) => (
								<span key={size} className="flex flex-col items-center gap-2">
									<Mascot
										key={`${SAMPLE_ID}-${size}-${replay}`}
										id={SAMPLE_ID}
										size={size}
										state={state}
									/>
									<span className="text-12 text-muted">{size}</span>
								</span>
							))}
						</div>
					</section>
					<section className="rounded-card bg-bg p-4 md:p-6">
						<h2 className="text-14 font-semibold">正在工作</h2>
						<p className="mt-1 text-12 text-muted">
							思考时三点跳动；执行工具时换成一句灰字
						</p>
						<WorkingIndicator
							agent={{ id: "demo-agent-twin", displayName: twinName("林晓") }}
						/>
						<WorkingIndicator
							agent={{
								id: "demo-agent-assistant",
								displayName: defaultAssistantName("林晓"),
							}}
							label="正在执行命令…"
						/>
					</section>
				</div>
			</main>
		</div>
	);
}
