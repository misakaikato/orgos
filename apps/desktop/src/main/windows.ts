/**
 * 两个窗口：聊天窗口（加载服务器上的 Web 应用，第一次启动时是本地的服务器地址页）
 * 与 Runner 控制窗口（app 自带的本地页面）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BrowserWindow, screen, shell } from "electron";
import { decideNavigation } from "@/main/navigation";
import {
	MIN_SIZE,
	parseWindowState,
	restoreBounds,
	type WindowState,
} from "@/main/window-state";

export type Pages = {
	/** 打包后的本地页面与 preload 所在目录。 */
	dir: string;
	setup: string;
	control: string;
	chatPreload: string;
	controlPreload: string;
};

export function pageUrl(file: string): string {
	return pathToFileURL(file).href;
}

function readWindowState(file: string): WindowState | null {
	try {
		return parseWindowState(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

function saveWindowState(win: BrowserWindow, file: string): void {
	if (win.isDestroyed()) return;
	const b = win.getNormalBounds();
	const state: WindowState = { ...b, maximized: win.isMaximized() };
	writeFileSync(file, `${JSON.stringify(state)}\n`);
}

/** 让 webContents 只在允许的地址内导航，外部链接交给系统浏览器。 */
function guardNavigation(
	win: BrowserWindow,
	serverOrigin: () => string | null,
	localPages: readonly string[],
): void {
	const wc = win.webContents;
	wc.on("will-navigate", (event, url) => {
		const d = decideNavigation(url, serverOrigin(), localPages);
		if (d === "allow") return;
		event.preventDefault();
		if (d === "external") void shell.openExternal(url);
	});
	wc.setWindowOpenHandler(({ url }) => {
		const d = decideNavigation(url, serverOrigin(), localPages);
		if (d === "allow") void wc.loadURL(url);
		else if (d === "external") void shell.openExternal(url);
		return { action: "deny" };
	});
}

export function createChatWindow(opts: {
	pages: Pages;
	stateFile: string;
	serverOrigin: () => string | null;
	/** 关窗时是否只隐藏（退出流程之外都只隐藏）。 */
	hideOnClose: () => boolean;
}): BrowserWindow {
	const displays = screen.getAllDisplays().map((d) => d.workArea);
	const { bounds, maximized } = restoreBounds(
		readWindowState(opts.stateFile),
		displays,
	);
	const win = new BrowserWindow({
		...bounds,
		minWidth: MIN_SIZE.width,
		minHeight: MIN_SIZE.height,
		title: "orgos",
		show: false,
		webPreferences: {
			preload: opts.pages.chatPreload,
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			spellcheck: false,
		},
	});
	if (maximized) win.maximize();
	win.once("ready-to-show", () => win.show());
	guardNavigation(win, opts.serverOrigin, [pageUrl(opts.pages.setup)]);

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	const scheduleSave = () => {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveWindowState(win, opts.stateFile), 500);
	};
	win.on("resize", scheduleSave);
	win.on("move", scheduleSave);
	win.on("close", (event) => {
		saveWindowState(win, opts.stateFile);
		if (!opts.hideOnClose()) return;
		event.preventDefault();
		win.hide();
	});
	return win;
}

export function createControlWindow(pages: Pages): BrowserWindow {
	const win = new BrowserWindow({
		width: 560,
		height: 760,
		minWidth: 440,
		minHeight: 480,
		title: "Runner 控制",
		show: false,
		webPreferences: {
			preload: pages.controlPreload,
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			spellcheck: false,
		},
	});
	win.once("ready-to-show", () => win.show());
	guardNavigation(win, () => null, [pageUrl(pages.control)]);
	void win.loadURL(pageUrl(pages.control));
	return win;
}
