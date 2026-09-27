import type { Principal } from "@orgos/protocol";
import { Mascot, type MascotState } from "@/components/mascot";
import { cx } from "@/lib/cx";
import { avatarText, avatarTone, hashString } from "@/lib/principals";

const TONES = [
	"bg-avatar-1",
	"bg-avatar-2",
	"bg-avatar-3",
	"bg-avatar-4",
	"bg-avatar-5",
	"bg-avatar-6",
] as const;

/** 头像里文字的字号：随尺寸缩放，只用字号刻度里的值。 */
function textSize(size: number): string {
	if (size >= 72) return "text-20";
	if (size >= 40) return "text-14";
	if (size >= 32) return "text-12";
	return "text-11";
}

/** 人的头像：正圆、--avatar-N 底、白字，名字最后两个字（DESIGN.md §4）。 */
export function PersonAvatar({
	principal,
	size = 40,
	className,
}: {
	principal: Pick<Principal, "handle" | "displayName">;
	size?: number;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			style={{ width: size, height: size }}
			className={cx(
				"inline-flex shrink-0 select-none items-center justify-center rounded-pill font-semibold leading-none text-on-color",
				TONES[avatarTone(principal.handle) - 1],
				textSize(size),
				className,
			)}
		>
			{size < 28
				? Array.from(avatarText(principal.displayName)).at(-1)
				: avatarText(principal.displayName)}
		</span>
	);
}

/**
 * 主体头像：人 = 正圆头像；代理 = 团子。自由轮廓 vs 正圆是人机区分的第一信号。
 */
export function Avatar({
	principal,
	size = 40,
	state,
	className,
}: {
	principal: Pick<Principal, "id" | "kind" | "handle" | "displayName">;
	size?: number;
	/** 只对代理有效。 */
	state?: MascotState;
	className?: string;
}) {
	return principal.kind === "agent" ? (
		<Mascot id={principal.id} size={size} state={state} className={className} />
	) : (
		<PersonAvatar principal={principal} size={size} className={className} />
	);
}

/** 群头像：圆角方块（与人的正圆、团子的自由轮廓都不同），群名前两个字。 */
export function GroupAvatar({
	id,
	title,
	size = 40,
	className,
}: {
	id: string;
	title: string;
	size?: number;
	className?: string;
}) {
	const text = Array.from(title.replace(/\s+/g, "")).slice(0, 2).join("");
	return (
		<span
			aria-hidden="true"
			style={{ width: size, height: size }}
			className={cx(
				"inline-flex shrink-0 select-none items-center justify-center rounded-card font-semibold leading-none text-on-color",
				TONES[hashString(id) % TONES.length],
				textSize(size),
				className,
			)}
		>
			{text || "群"}
		</span>
	);
}
