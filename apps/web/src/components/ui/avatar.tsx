import type { Principal } from "@orgos/protocol";
import { IconGroup } from "@/components/icons";
import { cx } from "@/lib/cx";
import { avatarTone, initialOf } from "@/lib/principals";

export type AvatarSize = "sm" | "md" | "lg";

const sizes: Record<AvatarSize, string> = {
	sm: "size-6 text-12",
	md: "size-8 text-13",
	lg: "size-10 text-15",
};

const tones = [
	"bg-avatar-1",
	"bg-avatar-2",
	"bg-avatar-3",
	"bg-avatar-4",
	"bg-avatar-5",
	"bg-avatar-6",
] as const;

/**
 * 形状是区分人机的第一信号：人 = 圆形实心底；代理 = 圆角方形、--agent-surface 底加描边、等宽首字。
 * 代理首字取其本人名字的首字（"林晓的幕僚长" → 林）。
 */
export function Avatar({
	principal,
	size = "md",
	className,
}: {
	principal: Pick<Principal, "kind" | "handle" | "displayName">;
	size?: AvatarSize;
	className?: string;
}) {
	const isAgent = principal.kind === "agent";
	return (
		<span
			aria-hidden="true"
			className={cx(
				"inline-flex shrink-0 select-none items-center justify-center font-medium text-ink",
				sizes[size],
				isAgent
					? "rounded-square border border-line bg-agent-surface font-code"
					: cx("rounded-full", tones[avatarTone(principal.handle) - 1]),
				className,
			)}
		>
			{initialOf(principal.displayName)}
		</span>
	);
}

/** 群聊头像：既不是人也不是代理，用中性方块加群组图标。 */
export function GroupAvatar({
	size = "md",
	className,
}: {
	size?: AvatarSize;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cx(
				"inline-flex shrink-0 items-center justify-center rounded-box bg-surface-2 text-muted",
				sizes[size],
				className,
			)}
		>
			<IconGroup size={size === "sm" ? 14 : 18} />
		</span>
	);
}
