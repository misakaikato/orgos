import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme";

export default function AuthLayout({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-dvh flex-col bg-bg">
			<header className="flex items-center justify-between px-6 py-4">
				<span className="font-code text-13 text-muted">orgos</span>
				<ThemeToggle />
			</header>
			<main className="flex flex-1 items-start justify-center px-4 pb-12 pt-8 md:items-center md:pt-0">
				{children}
			</main>
		</div>
	);
}
