import type { ReactNode } from "react";
import { Mascot } from "@/components/mascot";
import { ThemeToggle } from "@/components/theme";

export default function AuthLayout({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-dvh flex-col bg-sidebar">
			<header className="flex items-center justify-between px-4 py-3 md:px-6">
				<span className="flex items-center gap-2 text-16 font-semibold text-ink">
					<Mascot id="orgos" size={28} />
					orgos
				</span>
				<ThemeToggle />
			</header>
			<main className="flex flex-1 items-start justify-center px-4 pt-6 pb-12 md:items-center md:pt-0">
				{children}
			</main>
		</div>
	);
}
