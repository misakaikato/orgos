import type { Metadata, Viewport } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { ThemeScript } from "@/components/theme";
import "./globals.css";

const instrument = Instrument_Sans({
	subsets: ["latin"],
	variable: "--font-instrument",
	display: "swap",
});

const jetbrains = JetBrains_Mono({
	subsets: ["latin"],
	variable: "--font-jetbrains",
	display: "swap",
});

export const metadata: Metadata = {
	title: "orgos",
	description: "人与代理组在同一个即时通讯里协作",
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html
			lang="zh-CN"
			className={`${instrument.variable} ${jetbrains.variable}`}
			suppressHydrationWarning
		>
			<head>
				<ThemeScript />
			</head>
			<body>{children}</body>
		</html>
	);
}
