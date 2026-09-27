import type { FormEvent, ReactNode } from "react";
import { Mascot } from "@/components/mascot";

/** 卡片顶上的三只团子：固定 id，形象不随页面变化。 */
const TRIO = ["orgos-hello-1", "orgos-hello-2", "orgos-hello-3"];

/** 登录、注册、入驻共用的居中卡片，团子作点缀。 */
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
		<section className="w-full max-w-sm">
			<div
				aria-hidden="true"
				className="mb-[-10px] flex items-end justify-center"
			>
				<Mascot id={TRIO[0] ?? ""} size={44} className="-mr-2 translate-y-1" />
				<Mascot id={TRIO[1] ?? ""} size={60} className="relative z-10" />
				<Mascot id={TRIO[2] ?? ""} size={44} className="-ml-2 translate-y-1" />
			</div>
			<div className="rounded-card bg-bg px-6 pt-8 pb-6 shadow-float md:px-8">
				<h1 className="text-center text-20 font-semibold text-ink">{title}</h1>
				<p className="mt-1.5 text-center text-14 text-balance text-muted">
					{subtitle}
				</p>
				<form
					className="mt-6 flex flex-col gap-4"
					onSubmit={onSubmit}
					noValidate
				>
					{children}
					{error ? (
						<p role="alert" className="text-13 text-danger">
							{error}
						</p>
					) : null}
				</form>
			</div>
			{footer ? (
				<div className="mt-5 text-center text-13 text-muted">{footer}</div>
			) : null}
		</section>
	);
}
