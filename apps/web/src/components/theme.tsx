"use client";

import { useEffect, useState } from "react";
import { IconMoon, IconSun, IconSystem } from "@/components/icons";
import { IconButton } from "@/components/ui/button";
import { cx } from "@/lib/cx";

/**
 * 主题：默认跟随系统；用户选择存 localStorage，写到 <html data-theme>（tokens.css 据此覆盖）。
 */
export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "orgos-theme";
const ORDER: ThemeChoice[] = ["system", "light", "dark"];
const LABEL: Record<ThemeChoice, string> = {
	system: "跟随系统",
	light: "浅色",
	dark: "深色",
};
const ICON = { system: IconSystem, light: IconSun, dark: IconMoon } as const;

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

function useThemeChoice(): [ThemeChoice, (c: ThemeChoice) => void] {
	const [choice, setChoice] = useState<ThemeChoice>("system");
	useEffect(() => setChoice(readChoice()), []);
	return [
		choice,
		(c) => {
			applyChoice(c);
			setChoice(c);
		},
	];
}

/** 单个图标按钮，点一下切到下一种主题（登录页、模拟台的页头）。 */
export function ThemeToggle({ className }: { className?: string }) {
	const [choice, choose] = useThemeChoice();
	const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length] ?? "system";
	const Icon = ICON[choice];
	return (
		<IconButton
			label={`主题：${LABEL[choice]}`}
			className={className}
			onClick={() => choose(next)}
		>
			<Icon />
		</IconButton>
	);
}

/** 三段式主题选择（头像菜单、"我的"页）。 */
export function ThemeSegmented({ className }: { className?: string }) {
	const [choice, choose] = useThemeChoice();
	return (
		<div
			role="toolbar"
			aria-label="主题"
			className={cx("flex gap-1 rounded-pill bg-surface-2 p-1", className)}
		>
			{ORDER.map((c) => {
				const Icon = ICON[c];
				return (
					<button
						key={c}
						type="button"
						aria-pressed={choice === c}
						onClick={() => choose(c)}
						className={cx(
							"inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-pill px-2 text-12 whitespace-nowrap transition-colors duration-150",
							choice === c
								? "bg-bg font-medium text-ink shadow-card-hover"
								: "text-muted hover:text-ink",
						)}
					>
						<Icon size={14} />
						{LABEL[c]}
					</button>
				);
			})}
		</div>
	);
}
