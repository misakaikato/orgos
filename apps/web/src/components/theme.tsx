"use client";

import { useEffect, useState } from "react";
import { IconMoon, IconSun, IconSystem } from "@/components/icons";
import { IconButton } from "@/components/ui/button";

/**
 * 主题：默认跟随系统；用户选择存 localStorage，写到 <html data-theme>（tokens.css 据此覆盖）。
 */
type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "orgos-theme";
const ORDER: ThemeChoice[] = ["system", "light", "dark"];
const LABEL: Record<ThemeChoice, string> = {
	system: "主题：跟随系统",
	light: "主题：浅色",
	dark: "主题：深色",
};

function readChoice(): ThemeChoice {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		return v === "light" || v === "dark" ? v : "system";
	} catch {
		return "system";
	}
}

function applyChoice(choice: ThemeChoice): void {
	const root = document.documentElement;
	if (choice === "system") root.removeAttribute("data-theme");
	else root.setAttribute("data-theme", choice);
	try {
		if (choice === "system") localStorage.removeItem(STORAGE_KEY);
		else localStorage.setItem(STORAGE_KEY, choice);
	} catch {}
}

/** 首帧前应用已存的主题，避免闪烁。 */
const bootScript = `try{var t=localStorage.getItem("${STORAGE_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export function ThemeScript() {
	// biome-ignore lint/security/noDangerouslySetInnerHtml: 常量脚本，不含任何外部输入。
	return <script dangerouslySetInnerHTML={{ __html: bootScript }} />;
}

export function ThemeToggle({ className }: { className?: string }) {
	const [choice, setChoice] = useState<ThemeChoice>("system");
	useEffect(() => setChoice(readChoice()), []);
	const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length] ?? "system";
	const Icon =
		choice === "light" ? IconSun : choice === "dark" ? IconMoon : IconSystem;
	return (
		<IconButton
			label={LABEL[choice]}
			className={className}
			onClick={() => {
				applyChoice(next);
				setChoice(next);
			}}
		>
			<Icon />
		</IconButton>
	);
}
