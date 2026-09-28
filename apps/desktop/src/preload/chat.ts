/**
 * 聊天窗口的 preload：只暴露角标、回到前台；服务器上的页面另有本机 Runner 的身份与自动配对，
 * 本地的服务器地址页另有保存服务器地址。
 */
import { contextBridge, ipcRenderer } from "electron";
import {
	IPC,
	type OrgosDesktopApi,
	type Result,
	type RunnerIdentity,
} from "@/shared/ipc";

const api: OrgosDesktopApi = {
	setBadge: (count) => {
		if (Number.isInteger(count) && count >= 0)
			ipcRenderer.send(IPC.setBadge, count);
	},
	focus: () => ipcRenderer.send(IPC.focus),
	...(location.protocol === "file:"
		? {
				saveServer: (url: string): Promise<Result> =>
					ipcRenderer.invoke(IPC.saveServer, url),
			}
		: {
				runnerIdentity: (): Promise<RunnerIdentity> =>
					ipcRenderer.invoke(IPC.runnerIdentity),
				pairRunner: (code: string): Promise<Result> =>
					ipcRenderer.invoke(IPC.pairRunner, code),
				onRunnerEnabled: (fn: () => void) => {
					ipcRenderer.on(IPC.runnerEnabled, () => fn());
				},
			}),
};

contextBridge.exposeInMainWorld("orgosDesktop", api);
