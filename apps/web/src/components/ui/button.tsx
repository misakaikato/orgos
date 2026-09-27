"use client";

import Link from "next/link";
import {
	type ButtonHTMLAttributes,
	type ComponentProps,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const base =
	"inline-flex h-control shrink-0 items-center justify-center gap-1.5 rounded-pill px-4 text-13 font-medium whitespace-nowrap transition-[background-color,color,opacity,filter] duration-150 disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
	primary: "bg-accent text-on-accent hover:brightness-110",
	secondary: "bg-surface-2 text-ink hover:bg-line",
	danger: "bg-surface-2 text-danger hover:bg-line",
	ghost: "text-muted hover:bg-surface-2 hover:text-ink",
};

export function buttonClass(
	variant: ButtonVariant = "secondary",
	className?: string,
): string {
	return cx(base, variants[variant], className);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: ButtonVariant;
};

/** 胶囊按钮，高 32px（DESIGN.md §4）。每个区域最多一个 primary。 */
export function Button({
	variant = "secondary",
	className,
	type = "button",
	...rest
}: ButtonProps) {
	return (
		<button type={type} className={buttonClass(variant, className)} {...rest} />
	);
}

type ButtonLinkProps = ComponentProps<typeof Link> & {
	variant?: ButtonVariant;
};

export function ButtonLink({
	variant = "secondary",
	className,
	...rest
}: ButtonLinkProps) {
	return <Link className={buttonClass(variant, className)} {...rest} />;
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	label: string;
	active?: boolean;
};

/** 只有图标的圆形按钮；label 作为无障碍名称与提示。 */
export function IconButton({
	label,
	active,
	className,
	type = "button",
	...rest
}: IconButtonProps) {
	return (
		<button
			type={type}
			aria-label={label}
			title={label}
			className={cx(
				"inline-flex size-8 shrink-0 items-center justify-center rounded-pill transition-colors duration-150",
				active
					? "bg-surface-2 text-ink"
					: "text-muted hover:bg-surface-2 hover:text-ink",
				className,
			)}
			{...rest}
		/>
	);
}

const SOON_MS = 1_600;

/**
 * 尚未接通的操作：外观与普通按钮一致，点击后在上方浮出"即将开放"。
 */
export function SoonButton({
	variant = "secondary",
	className,
	children,
	note = "即将开放",
}: {
	variant?: ButtonVariant;
	className?: string;
	children: ReactNode;
	note?: string;
}) {
	const [shown, setShown] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	return (
		<span className="relative inline-flex">
			<button
				type="button"
				className={buttonClass(variant, className)}
				onClick={() => {
					setShown(true);
					if (timer.current) clearTimeout(timer.current);
					timer.current = setTimeout(() => setShown(false), SOON_MS);
				}}
			>
				{children}
			</button>
			{shown ? (
				<span
					role="status"
					className="absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 animate-pop-in rounded-pill bg-ink px-3 py-1 text-12 whitespace-nowrap text-bg"
				>
					{note}
				</span>
			) : null}
		</span>
	);
}
