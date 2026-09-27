/**
 * 手写内联 SVG 图标：24 网格、1.75px 描边、圆角端点、currentColor。不引图标库（DESIGN.md §7）。
 */
import type { ReactNode, SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function Icon({
	size = 20,
	children,
	...rest
}: IconProps & { children: ReactNode }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.75}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			{...rest}
		>
			{children}
		</svg>
	);
}

/** 消息：圆润的对话气泡。 */
export function IconChat(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M12 4.5c4.7 0 8 3 8 6.8s-3.3 6.8-8 6.8c-1 0-2-.1-2.8-.4L5.5 19.5l.9-3.3C4.9 15 4 13.3 4 11.3 4 7.5 7.3 4.5 12 4.5z" />
		</Icon>
	);
}

/** 待办：带勾的便签。 */
export function IconTodo(p: IconProps) {
	return (
		<Icon {...p}>
			<rect x="4.5" y="4" width="15" height="16.5" rx="3.5" />
			<path d="M8.5 12.2l2.3 2.3 4.7-4.7" />
		</Icon>
	);
}

/** 通讯录：人像卡。 */
export function IconContacts(p: IconProps) {
	return (
		<Icon {...p}>
			<circle cx="12" cy="9" r="3.5" />
			<path d="M5.5 19.5c1.1-3 3.6-4.8 6.5-4.8s5.4 1.8 6.5 4.8" />
		</Icon>
	);
}

/** 代理组：一只小团子。 */
export function IconAgents(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M12 5c4.6 0 7.5 3.4 7.5 8 0 4.1-3.2 6-7.5 6s-7.5-1.9-7.5-6c0-4.6 2.9-8 7.5-8z" />
			<path d="M12 5c0-1.3.8-2.2 2-2.3" />
			<path d="M9.5 12v1M14.5 12v1" />
		</Icon>
	);
}

/** 设备：笔记本电脑。 */
export function IconDevice(p: IconProps) {
	return (
		<Icon {...p}>
			<rect x="5" y="5.5" width="14" height="10" rx="2" />
			<path d="M3 18.5h18" />
		</Icon>
	);
}

/** 我的：人像圆。 */
export function IconMe(p: IconProps) {
	return (
		<Icon {...p}>
			<circle cx="12" cy="12" r="8.5" />
			<circle cx="12" cy="10" r="2.8" />
			<path d="M7 17.8c1.2-1.9 2.9-2.9 5-2.9s3.8 1 5 2.9" />
		</Icon>
	);
}

export function IconSearch(p: IconProps) {
	return (
		<Icon {...p}>
			<circle cx="11" cy="11" r="6" />
			<path d="M15.5 15.5L19.5 19.5" />
		</Icon>
	);
}

export function IconPlus(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M12 5v14M5 12h14" />
		</Icon>
	);
}

/** 发送：向上的箭头。 */
export function IconSend(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M12 19V5.5M6 11l6-6 6 6" />
		</Icon>
	);
}

export function IconBack(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M15 5l-7 7 7 7" />
		</Icon>
	);
}

export function IconChevronRight(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M9.5 6l6 6-6 6" />
		</Icon>
	);
}

export function IconClose(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M6 6l12 12M18 6L6 18" />
		</Icon>
	);
}

export function IconPanel(p: IconProps) {
	return (
		<Icon {...p}>
			<rect x="3.5" y="4.5" width="17" height="15" rx="3" />
			<path d="M14.5 4.5v15" />
		</Icon>
	);
}

export function IconArrowDown(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M12 5v14M6 13l6 6 6-6" />
		</Icon>
	);
}

export function IconSun(p: IconProps) {
	return (
		<Icon {...p}>
			<circle cx="12" cy="12" r="3.5" />
			<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
		</Icon>
	);
}

export function IconMoon(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z" />
		</Icon>
	);
}

export function IconSystem(p: IconProps) {
	return (
		<Icon {...p}>
			<circle cx="12" cy="12" r="8" />
			<path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
		</Icon>
	);
}

export function IconLogout(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10" />
			<path d="M14 8l4 4-4 4M18 12H9" />
		</Icon>
	);
}

export function IconCheck(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M5 12.5l4.5 4.5L19 7.5" />
		</Icon>
	);
}

/** 附件：回形针。 */
export function IconClip(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M16.5 11.5l-5.2 5.2a3.3 3.3 0 0 1-4.7-4.7l6-6a2.2 2.2 0 0 1 3.1 3.1l-5.8 5.8a1.1 1.1 0 0 1-1.6-1.6l5-5" />
		</Icon>
	);
}

/** 停止：圆角方块。 */
export function IconStop(p: IconProps) {
	return (
		<Icon {...p}>
			<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
		</Icon>
	);
}

/** 模型：芯片。 */
export function IconModel(p: IconProps) {
	return (
		<Icon {...p}>
			<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
			<path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3" />
		</Icon>
	);
}
