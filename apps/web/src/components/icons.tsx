/**
 * 手写内联 SVG 图标：24 网格、1.5px 描边、currentColor。不引图标库（DESIGN.md §7）。
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
			strokeWidth={1.5}
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

export function IconChat(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17h0A1.5 1.5 0 0 1 4 15.5z" />
		</Icon>
	);
}

export function IconContacts(p: IconProps) {
	return (
		<Icon {...p}>
			<circle cx="12" cy="8.5" r="3.5" />
			<path d="M5 19.5c1.2-3.2 3.9-5 7-5s5.8 1.8 7 5" />
		</Icon>
	);
}

export function IconGroup(p: IconProps) {
	return (
		<Icon {...p}>
			<circle cx="9" cy="9" r="3" />
			<path d="M3.5 18.5c.9-2.8 3-4.3 5.5-4.3s4.6 1.5 5.5 4.3" />
			<path d="M15.5 6.3a3 3 0 0 1 0 5.4" />
			<path d="M17.5 14.6c1.3.7 2.3 2 2.9 3.9" />
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

export function IconSend(p: IconProps) {
	return (
		<Icon {...p}>
			<path d="M5 12h13M13 6l6 6-6 6" />
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
			<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
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
			<path d="M12 4v16" />
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
