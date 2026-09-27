import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
	title: "模拟台 · orgos",
};

export default function SimLayout({ children }: { children: ReactNode }) {
	return children;
}
