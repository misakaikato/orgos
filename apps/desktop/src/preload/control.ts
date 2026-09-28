/**
 * Runner 控制窗口的 preload：只暴露控制 Runner 所需的操作（主进程另外核对发送方是控制窗口）。
 */
import { contextBridge, ipcRenderer } from "electron";
import {
	type ControlState,
	IPC,
	type OrgosControlApi,
	type Result,
} from "@/shared/ipc";

const call =
	(channel: string) =>
	(...args: unknown[]): Promise<Result> =>
		ipcRenderer.invoke(channel, ...args);

const api: OrgosControlApi = {
	getState: () => ipcRenderer.invoke(IPC.getState),
	onState: (fn) => {
		ipcRenderer.on(IPC.state, (_e, state: ControlState) => fn(state));
	},
	setServer: call(IPC.setServer),
	pair: call(IPC.pair),
	unpair: call(IPC.unpair),
	chooseWorkspace: call(IPC.chooseWorkspace),
	setAdapters: call(IPC.setAdapters),
	setRunAsRunner: call(IPC.setRunAsRunner),
	setOpenAtLogin: call(IPC.setOpenAtLogin),
	start: call(IPC.start),
	stop: call(IPC.stop),
	restart: call(IPC.restart),
	openLog: call(IPC.openLog),
	confirmQuit: call(IPC.confirmQuit),
	cancelQuit: call(IPC.cancelQuit),
};

contextBridge.exposeInMainWorld("orgosControl", api);
