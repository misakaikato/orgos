import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";
import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const base =
	"inline-flex h-control shrink-0 items-center justify-center gap-2 rounded-capsule px-4 text-13 font-medium whitespace-nowrap transition-[background-color,box-shadow,color] duration-150 disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
	primary: "bg-accent text-surface hover:ring-4 hover:ring-accent-soft",
	secondary: "border border-line text-ink hover:bg-surface-2",
	danger: "border border-danger text-danger hover:bg-surface-2",
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

/** 胶囊按钮，高 32px。每个区域最多一个 primary。 */
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

/** 只有图标的方形胶囊按钮；label 作为无障碍名称与提示。 */
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
				"inline-flex size-8 shrink-0 items-center justify-center rounded-capsule transition-colors duration-150",
				active
					? "bg-surface-2 text-ink"
					: "text-muted hover:bg-surface-2 hover:text-ink",
				className,
			)}
			{...rest}
		/>
	);
}
