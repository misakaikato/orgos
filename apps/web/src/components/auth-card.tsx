import type { FormEvent, ReactNode } from "react";

/** 登录、注册、入驻共用的表单卡片。 */
export function AuthCard({
	title,
	subtitle,
	onSubmit,
	error,
	children,
	footer,
}: {
	title: string;
	subtitle: string;
	onSubmit: (e: FormEvent<HTMLFormElement>) => void;
	error: string | null;
	children: ReactNode;
	footer?: ReactNode;
}) {
	return (
		<section className="w-full max-w-sm rounded-box border border-line bg-surface p-8">
			<h1 className="font-display text-22 text-ink">{title}</h1>
			<p className="mt-2 text-14 text-muted">{subtitle}</p>
			<form className="mt-6 flex flex-col gap-4" onSubmit={onSubmit} noValidate>
				{children}
				{error ? (
					<p role="alert" className="text-13 text-danger">
						{error}
					</p>
				) : null}
			</form>
			{footer ? <div className="mt-6 text-13 text-muted">{footer}</div> : null}
		</section>
	);
}
