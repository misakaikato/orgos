import type { Principal, PrincipalStatus } from "@orgos/protocol";
import { Mascot, type MascotState } from "@/components/mascot";
import { cx } from "@/lib/cx";
import {
	avatarText,
	avatarTone,
	hashString,
	STATUS_LABEL,
} from "@/lib/principals";

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

const STATUS_DOT: Record<PrincipalStatus, string> = {
	available: "bg-good",
	busy: "bg-pending",
	away: "bg-muted",
};

/** 状态点外圈与所在背景同色（DESIGN.md §4 状态点）。 */
export type StatusRing = "bg" | "sidebar" | "accent-soft" | "list-row";

const RINGS: Record<StatusRing, string> = {
	bg: "ring-bg",
	sidebar: "ring-sidebar",
	"accent-soft": "ring-accent-soft",
	/** 会话列表行：底为 --sidebar，悬停时 --surface-2（行需带 group）。 */
	"list-row": "ring-sidebar group-hover:ring-surface-2",
};

/** 人的头像：正圆、--avatar-N 底、白字，名字最后两个字（DESIGN.md §4）；可带右下角状态点。 */
export function PersonAvatar({
	principal,
	size = 40,
	showStatus = false,
	ring = "bg",
	className,
}: {
	principal: Pick<Principal, "handle" | "displayName" | "status">;
	size?: number;
	/** 显示在线状态点（只对带状态的人生效）。 */
	showStatus?: boolean;
	ring?: StatusRing;
	className?: string;
}) {
	const status = showStatus ? principal.status : undefined;
	return (
		<span
			style={{ width: size, height: size }}
			className={cx("relative inline-flex shrink-0", className)}
		>
			<span
				aria-hidden="true"
				className={cx(
					"inline-flex size-full select-none items-center justify-center rounded-pill font-semibold leading-none text-on-color",
					TONES[avatarTone(principal.handle) - 1],
					textSize(size),
				)}
			>
				{size < 28
					? Array.from(avatarText(principal.displayName)).at(-1)
					: avatarText(principal.displayName)}
			</span>
			{status ? (
				<span
					role="img"
					aria-label={STATUS_LABEL[status]}
					title={STATUS_LABEL[status]}
					className={cx(
						"absolute right-0 bottom-0 size-2.5 rounded-pill ring-2",
						STATUS_DOT[status],
						RINGS[ring],
					)}
				/>
			) : null}
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
	showStatus,
	ring,
	className,
}: {
	principal: Pick<Principal, "id" | "kind" | "handle" | "displayName"> &
		Partial<Pick<Principal, "status">>;
	size?: number;
	/** 只对代理有效。 */
	state?: MascotState;
	/** 只对人有效：显示在线状态点。 */
	showStatus?: boolean;
	ring?: StatusRing;
	className?: string;
}) {
	return principal.kind === "agent" ? (
		<Mascot id={principal.id} size={size} state={state} className={className} />
	) : (
		<PersonAvatar
			principal={principal}
			size={size}
			showStatus={showStatus}
			ring={ring}
			className={className}
		/>
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
