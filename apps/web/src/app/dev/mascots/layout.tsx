import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
	title: "团子预览 · orgos",
};

export default function MascotsLayout({ children }: { children: ReactNode }) {
	return children;
}
