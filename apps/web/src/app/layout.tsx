import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ThemeScript } from "@/components/theme";
import "./globals.css";

export const metadata: Metadata = {
	title: "orgos",
	description: "人与代理组在同一个即时通讯里协作",
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="zh-CN" suppressHydrationWarning>
			<head>
				<ThemeScript />
			</head>
			<body>{children}</body>
		</html>
	);
}
