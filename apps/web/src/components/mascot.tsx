/**
 * 团子吉祥物：代理的唯一形象（DESIGN.md §4）。任何地方的代理头像都用它。
 *
 * - 12 张扁平矢量插画（public/mascots，256×256 透明底），由代理 id 确定性选取。
 * - 状态：idle 4s 一次极轻的呼吸；working 上下 2px、1.2s 缓动弹跳；
 *   done 一次轻微放大回弹后回到呼吸。prefers-reduced-motion 下全部静止。
 */
import { cx } from "@/lib/cx";
import { mascotArt } from "@/lib/principals";

export type MascotState = "idle" | "working" | "done";

/** 团子名字色（--mascot-N-ink）的工具类；与插画的团子色同一个 N。 */
const INK_CLASSES = [
	"text-mascot-1-ink",
	"text-mascot-2-ink",
	"text-mascot-3-ink",
	"text-mascot-4-ink",
	"text-mascot-5-ink",
	"text-mascot-6-ink",
	"text-mascot-7-ink",
	"text-mascot-8-ink",
] as const;

/** 团子色 N（1–8）的名字色类。 */
export function toneInkClass(tone: number): string {
	return INK_CLASSES[tone - 1] ?? INK_CLASSES[0];
}

/** 代理名字的颜色类：与它的团子同色（DESIGN.md §2）。 */
export function mascotInkClass(id: string): string {
	return toneInkClass(mascotArt(id).tone);
}

const MOTION: Record<MascotState, string> = {
	idle: "motion-safe:animate-mascot-breathe",
	working: "motion-safe:animate-mascot-bounce",
	done: "motion-safe:animate-mascot-done",
};

export function Mascot({
	id,
	size = 40,
	state = "idle",
	label,
	className,
}: {
	/** 代理的主体 id：决定是哪张插画与名字色。 */
	id: string;
	size?: number;
	state?: MascotState;
	/** 代理显示名，作为图片的 alt；不传则视为装饰。 */
	label?: string;
	className?: string;
}) {
	const art = mascotArt(id);
	return (
		// biome-ignore lint/performance/noImgElement: 256px 静态 PNG，无需 next/image 的优化管线。
		<img
			src={art.src}
			width={size}
			height={size}
			alt={label ?? ""}
			aria-hidden={label ? undefined : true}
			draggable={false}
			decoding="async"
			className={cx(
				"shrink-0 origin-bottom select-none",
				MOTION[state],
				className,
			)}
		/>
	);
}
