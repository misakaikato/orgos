/**
 * 主进程与页面之间的 IPC 约定：通道名与出入参类型（主进程、preload、控制窗口页面共用）。
 */
import type { Settings } from "@/main/settings";
import type { RunnerPhase, RunnerStatus } from "@/main/supervisor";

export const IPC = {
	/** 聊天窗口（远端页面）可用。 */
	setBadge: "orgos:set-badge",
	focus: "orgos:focus",
	/** 只在第一次启动的服务器地址页可用。 */
	saveServer: "orgos:save-server",
	/** 以下只在控制窗口可用。 */
	getState: "orgos:get-state",
	state: "orgos:state",
	setServer: "orgos:set-server",
	pair: "orgos:pair",
	unpair: "orgos:unpair",
	chooseWorkspace: "orgos:choose-workspace",
	setAdapters: "orgos:set-adapters",
	setAutoStart: "orgos:set-auto-start",
	setOpenAtLogin: "orgos:set-open-at-login",
	start: "orgos:start",
	stop: "orgos:stop",
	restart: "orgos:restart",
	openLog: "orgos:open-log",
	confirmQuit: "orgos:confirm-quit",
	cancelQuit: "orgos:cancel-quit",
} as const;

export type AdapterView = {
	id: string;
	label: string;
	note: string;
	/** 登录 PATH 上找不到的可执行文件；为空即已安装。 */
	missing: string[];
	enabled: boolean;
};

export type ControlState = {
	settings: Settings;
	phase: RunnerPhase;
	phaseLabel: string;
	status: RunnerStatus;
	paired: boolean;
	adapters: AdapterView[];
	logFile: string;
	/** 登录 shell 的 PATH 解析失败的原因（成功为 null）。 */
	loginPathError: string | null;
	/** 退出前待确认：进行中的事项数。 */
	quitPending: { busy: number } | null;
	/** 配对时预填的设备名。 */
	defaultDeviceName: string;
	appVersion: string;
};

export type Result =
	| { ok: true; message?: string }
	| { ok: false; message: string };

/** 控制窗口的 preload 暴露为 `window.orgosControl`。 */
export interface OrgosControlApi {
	getState(): Promise<ControlState>;
	onState(fn: (state: ControlState) => void): void;
	setServer(url: string): Promise<Result>;
	pair(code: string, name: string): Promise<Result>;
	unpair(): Promise<Result>;
	chooseWorkspace(): Promise<Result>;
	setAdapters(ids: string[] | null): Promise<Result>;
	setAutoStart(on: boolean): Promise<Result>;
	setOpenAtLogin(on: boolean): Promise<Result>;
	start(): Promise<Result>;
	stop(): Promise<Result>;
	restart(): Promise<Result>;
	openLog(): Promise<Result>;
	confirmQuit(): Promise<Result>;
	cancelQuit(): Promise<Result>;
}

/** 聊天窗口的 preload 暴露为 `window.orgosDesktop`（apps/web 的 lib/desktop.ts 使用）。 */
export interface OrgosDesktopApi {
	setBadge(count: number): void;
	focus(): void;
	/** 只在第一次启动的服务器地址页上存在。 */
	saveServer?: (url: string) => Promise<Result>;
}
