"use client";

import { useState } from "react";
import { WorkingIndicator } from "@/components/conversation/working-indicator";
import { Mascot, type MascotState, mascotInkClass } from "@/components/mascot";
import { ThemeToggle } from "@/components/theme";
import { cx } from "@/lib/cx";
import { mascotTraits } from "@/lib/principals";

/** 24 个示例 id：与真实代理 id 一样走哈希，只为铺满各种组合。 */
const IDS = Array.from(
	{ length: 24 },
	(_, i) => `demo-agent-${String(i + 1).padStart(2, "0")}`,
);

const STATES: { key: MascotState; label: string }[] = [
	{ key: "idle", label: "待命" },
	{ key: "working", label: "工作中" },
	{ key: "done", label: "完成" },
];

const SHAPE_LABEL = {
	round: "圆团",
	pear: "梨形",
	bean: "豆形",
	sprout: "呆毛",
};
const EYES_LABEL = { dot: "圆点眼", smile: "笑眼", oval: "竖椭圆眼" };
const SIZES = [72, 40, 32, 28];

/** 开发用：团子全组合预览与"正在工作"指示（仅 ORGOS_DEV=1，由服务端守卫）。 */
export default function MascotsPage() {
	const [state, setState] = useState<MascotState>("idle");
	// 每次点"完成"都重新挂载，让开心弯眼再播一遍。
	const [replay, setReplay] = useState(0);
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
					<ul className="grid grid-cols-3 gap-x-2 gap-y-6 sm:grid-cols-4 md:grid-cols-6">
						{IDS.map((id) => {
							const t = mascotTraits(id);
							return (
								<li
									key={id}
									className="flex flex-col items-center gap-1.5 text-center"
								>
									<Mascot
										key={`${id}-${replay}`}
										id={id}
										size={72}
										state={state}
									/>
									<span
										className={cx("text-12 font-semibold", mascotInkClass(id))}
									>
										{`团子色 ${t.tone}`}
									</span>
									<span className="text-12 text-muted">
										{SHAPE_LABEL[t.shape]} · {EYES_LABEL[t.eyes]}
										{t.blush ? " · 腮红" : ""}
									</span>
								</li>
							);
						})}
					</ul>
				</section>
				<div className="grid gap-4 md:grid-cols-2">
					<section className="rounded-card bg-bg p-4 md:p-6">
						<h2 className="text-14 font-semibold">尺寸</h2>
						<p className="mt-1 text-12 text-muted">
							检查器与空状态 72、列表 40、气泡旁 32、会话标题 28
						</p>
						<div className="mt-4 flex items-end gap-6">
							{SIZES.map((size) => (
								<span key={size} className="flex flex-col items-center gap-2">
									<Mascot id={IDS[4] ?? ""} size={size} state={state} />
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
							agent={{ id: IDS[2] ?? "", displayName: "林晓的幕僚长" }}
						/>
						<WorkingIndicator
							agent={{ id: IDS[9] ?? "", displayName: "林晓的执行助理" }}
							label="正在执行命令…"
						/>
					</section>
				</div>
			</main>
		</div>
	);
}
