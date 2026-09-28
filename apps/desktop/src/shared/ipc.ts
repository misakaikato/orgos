/**
 * 主进程与页面之间的 IPC 约定：通道名与出入参类型（主进程、preload、控制窗口页面共用）。
 */
import type { BridgeResult as Result } from "@orgos/protocol";
import type { Settings } from "@/main/settings";
import type { RunnerPhase, RunnerStatus } from "@/main/supervisor";

/** 聊天窗口的桥接类型与结果类型定义在 protocol（Web 端共用），这里转出。 */
export type { OrgosDesktopApi, RunnerIdentity } from "@orgos/protocol";
export type { Result };

export const IPC = {
	/** 聊天窗口（远端页面）可用。 */
	setBadge: "orgos:set-badge",
	focus: "orgos:focus",
	/** 聊天窗口里、服务器源上的页面可用：本机 Runner 的身份与自动配对。 */
	runnerIdentity: "orgos:runner-identity",
	pairRunner: "orgos:pair-runner",
	/** 主进程 → 聊天窗口："本机作为 Runner"被打开，页面据此重新检查是否需要配对。 */
	runnerEnabled: "orgos:runner-enabled",
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
	setRunAsRunner: "orgos:set-run-as-runner",
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
	/** 本机配对的服务器（未配对为 null）。 */
	pairedServer: string | null;
	/** 配对时预填的设备名。 */
	defaultDeviceName: string;
	appVersion: string;
};

/** 控制窗口的 preload 暴露为 `window.orgosControl`。 */
export interface OrgosControlApi {
	getState(): Promise<ControlState>;
	onState(fn: (state: ControlState) => void): void;
	setServer(url: string): Promise<Result>;
	pair(code: string, name: string): Promise<Result>;
	unpair(): Promise<Result>;
	chooseWorkspace(): Promise<Result>;
	setAdapters(ids: string[] | null): Promise<Result>;
	setRunAsRunner(on: boolean): Promise<Result>;
	setOpenAtLogin(on: boolean): Promise<Result>;
	start(): Promise<Result>;
	stop(): Promise<Result>;
	restart(): Promise<Result>;
	openLog(): Promise<Result>;
	confirmQuit(): Promise<Result>;
	cancelQuit(): Promise<Result>;
}
