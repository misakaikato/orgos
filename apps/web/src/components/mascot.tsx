"use client";

/**
 * 团子吉祥物：代理的唯一形象（DESIGN.md §4）。任何地方的代理头像都用它。
 *
 * - 纯 SVG，viewBox 48×48；4 轮廓 × 3 眼型 × 可选腮红 × 8 色，由代理 id 确定性选取。
 * - 体积：底部同色加深的弧形阴影 + 左上一抹高光；眼睛带高光点。
 * - 状态：idle 每 5–9 秒随机眨眼；working 上下 2px 弹跳、眼睛看向右侧；
 *   done 一次 0.4s 的开心弯眼后回到 idle。prefers-reduced-motion 下只保留静态形象。
 */
import { useEffect, useId, useState } from "react";
import { cx } from "@/lib/cx";
import { useMediaQuery } from "@/lib/hooks";
import {
	type MascotEyes,
	type MascotShape,
	mascotTraits,
} from "@/lib/principals";

export type MascotState = "idle" | "working" | "done";

type Face = {
	body: string;
	/** 呆毛（只有 sprout 有）。 */
	tuft?: string;
	eyeY: number;
	eyeDX: number;
	blushY: number;
	blushDX: number;
	gloss: { cx: number; cy: number };
};

const FACES: Record<MascotShape, Face> = {
	round: {
		body: "M24 9.5C35.6 9.5 43.5 17.6 43.5 28.2 43.5 37.8 35.4 43.5 24 43.5 12.6 43.5 4.5 37.8 4.5 28.2 4.5 17.6 12.4 9.5 24 9.5Z",
		eyeY: 26.5,
		eyeDX: 7,
		blushY: 32,
		blushDX: 12.5,
		gloss: { cx: 14.5, cy: 17 },
	},
	pear: {
		body: "M24 8.5C30.6 8.5 34.6 13.4 35.6 19.2 40.6 22.2 43.6 27.4 43.6 32.6 43.6 39.6 35.4 43.5 24 43.5 12.6 43.5 4.4 39.6 4.4 32.6 4.4 27.4 7.4 22.2 12.4 19.2 13.4 13.4 17.4 8.5 24 8.5Z",
		eyeY: 28,
		eyeDX: 6.5,
		blushY: 33.5,
		blushDX: 12,
		gloss: { cx: 18, cy: 14.5 },
	},
	bean: {
		body: "M13.5 12.5C17.5 10.5 20.6 12.8 24 12.8 27.4 12.8 30.5 10.5 34.5 12.5 41 15.6 44.5 21.8 44.5 29 44.5 38 35.6 43.5 24 43.5 12.4 43.5 3.5 38 3.5 29 3.5 21.8 7 15.6 13.5 12.5Z",
		eyeY: 27.5,
		eyeDX: 7.5,
		blushY: 33,
		blushDX: 13.5,
		gloss: { cx: 12.5, cy: 19 },
	},
	sprout: {
		body: "M24 12C35 12 42.5 19.4 42.5 29 42.5 38 34.8 43.5 24 43.5 13.2 43.5 5.5 38 5.5 29 5.5 19.4 13 12 24 12Z",
		tuft: "M24 12.6C23.2 8.4 26.2 5.2 29.6 6.4 31.3 7 31 9.3 29.2 9.1",
		eyeY: 28.5,
		eyeDX: 7,
		blushY: 33.5,
		blushDX: 12.5,
		gloss: { cx: 15, cy: 19.5 },
	},
};

/** 团子名字色（--mascot-N-ink）的工具类；与身体色同一个 N。 */
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

/** 代理名字的颜色类：与它的团子同色（DESIGN.md §2）。 */
export function mascotInkClass(id: string): string {
	return INK_CLASSES[mascotTraits(id).tone - 1] ?? INK_CLASSES[0];
}

const BLINK_MIN_MS = 5_000;
const BLINK_SPAN_MS = 4_000;
const BLINK_MS = 140;
const HAPPY_MS = 400;

function Eye({
	kind,
	x,
	y,
	happy,
}: {
	kind: MascotEyes;
	x: number;
	y: number;
	happy: boolean;
}) {
	if (happy || kind === "smile") {
		const w = happy ? 2.9 : 2.6;
		return (
			<path
				d={`M${x - w} ${y + 0.9}Q${x} ${y - 2.8} ${x + w} ${y + 0.9}`}
				fill="none"
				stroke="var(--mascot-eye)"
				strokeWidth={2.3}
				strokeLinecap="round"
			/>
		);
	}
	if (kind === "oval") {
		return (
			<>
				<ellipse cx={x} cy={y} rx={2.1} ry={3.1} fill="var(--mascot-eye)" />
				<circle cx={x + 0.7} cy={y - 1.3} r={0.85} fill="var(--mascot-shine)" />
			</>
		);
	}
	return (
		<>
			<circle cx={x} cy={y} r={2.7} fill="var(--mascot-eye)" />
			<circle cx={x + 0.9} cy={y - 1} r={0.95} fill="var(--mascot-shine)" />
		</>
	);
}

export function Mascot({
	id,
	size = 40,
	state = "idle",
	label,
	className,
}: {
	/** 代理的主体 id：决定外形与颜色。 */
	id: string;
	size?: number;
	state?: MascotState;
	/** 给读屏的名字；不传则视为装饰。 */
	label?: string;
	className?: string;
}) {
	const traits = mascotTraits(id);
	const face = FACES[traits.shape];
	const clipId = useId();
	const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
	const [blink, setBlink] = useState(false);
	const [happy, setHappy] = useState(false);

	// idle：每 5–9 秒随机眨一次眼。
	useEffect(() => {
		if (reduced || state === "working") return;
		let timer: ReturnType<typeof setTimeout>;
		const schedule = () => {
			timer = setTimeout(
				() => {
					setBlink(true);
					timer = setTimeout(() => {
						setBlink(false);
						schedule();
					}, BLINK_MS);
				},
				BLINK_MIN_MS + Math.random() * BLINK_SPAN_MS,
			);
		};
		schedule();
		return () => {
			clearTimeout(timer);
			setBlink(false);
		};
	}, [reduced, state]);

	// done：开心弯眼 0.4s 后回到 idle。
	useEffect(() => {
		if (state !== "done" || reduced) return;
		setHappy(true);
		const timer = setTimeout(() => setHappy(false), HAPPY_MS);
		return () => clearTimeout(timer);
	}, [state, reduced]);

	const body = `var(--mascot-${traits.tone})`;
	const working = state === "working" && !reduced;
	const lookX = working ? 1.6 : 0;
	const { eyeY, eyeDX } = face;
	const mouthY = eyeY + 4.4;

	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 48 48"
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
			focusable="false"
			className={cx(
				"shrink-0 overflow-visible",
				working && "animate-mascot-bounce",
				className,
			)}
		>
			<defs>
				<clipPath id={clipId}>
					<path d={face.body} />
				</clipPath>
			</defs>
			{face.tuft ? (
				<path
					d={face.tuft}
					fill="none"
					stroke={body}
					strokeWidth={2.6}
					strokeLinecap="round"
				/>
			) : null}
			<path d={face.body} fill={body} />
			<g clipPath={`url(#${clipId})`}>
				<ellipse
					cx={24}
					cy={48.5}
					rx={25}
					ry={11.5}
					fill="var(--mascot-shade)"
				/>
				<ellipse
					cx={face.gloss.cx}
					cy={face.gloss.cy}
					rx={5}
					ry={2.8}
					transform={`rotate(-32 ${face.gloss.cx} ${face.gloss.cy})`}
					fill="var(--mascot-gloss)"
				/>
			</g>
			{traits.blush ? (
				<g fill="var(--mascot-blush)" opacity={0.5}>
					<ellipse cx={24 - face.blushDX} cy={face.blushY} rx={3.2} ry={2} />
					<ellipse cx={24 + face.blushDX} cy={face.blushY} rx={3.2} ry={2} />
				</g>
			) : null}
			<g
				style={{
					transform: `translateX(${lookX}px) scaleY(${blink ? 0.12 : 1})`,
					transformBox: "fill-box",
					transformOrigin: "center",
					transition: "transform 120ms ease-out",
				}}
			>
				<Eye kind={traits.eyes} x={24 - eyeDX} y={eyeY} happy={happy} />
				<Eye kind={traits.eyes} x={24 + eyeDX} y={eyeY} happy={happy} />
			</g>
			<path
				d={`M${22.4 + lookX} ${mouthY}Q${24 + lookX} ${mouthY + 1.9} ${25.6 + lookX} ${mouthY}`}
				fill="none"
				stroke="var(--mascot-eye)"
				strokeWidth={1.5}
				strokeLinecap="round"
			/>
		</svg>
	);
}
