/**
 * 聊天窗口的 preload：只暴露角标、回到前台，以及（仅在本地的服务器地址页上）保存服务器地址。
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type OrgosDesktopApi, type Result } from "@/shared/ipc";

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
		: {}),
};

contextBridge.exposeInMainWorld("orgosDesktop", api);
