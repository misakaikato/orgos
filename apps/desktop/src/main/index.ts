/**
 * orgos 桌面客户端的主进程：聊天窗口、菜单栏图标与 Runner 看护。
 */
import { homedir, hostname } from "node:os";
import path from "node:path";
import { ACP_ADAPTERS } from "@orgos/protocol";
import {
	app,
	type BrowserWindow,
	dialog,
	type IpcMainEvent,
	type IpcMainInvokeEvent,
	ipcMain,
	Menu,
	powerSaveBlocker,
	session,
	shell,
} from "electron";
import { RotatingLog } from "@/main/log-file";
import { findExecutable, resolveLoginPath } from "@/main/login-path";
import {
	isPaired,
	pairArgs,
	pairOutcome,
	removePairing,
	runnerBinaryName,
	runnerEnv,
	serveArgs,
} from "@/main/runner-cli";
import {
	killOrphanRunner,
	runOnce,
	runShell,
	spawnRunner,
	writeRunnerPid,
} from "@/main/runner-process";
import {
	adaptersFlag,
	normalizeServerUrl,
	SettingsStore,
} from "@/main/settings";
import { busyCount, phaseOf, RunnerSupervisor } from "@/main/supervisor";
import { createTray } from "@/main/tray";
import { PHASE_LABEL } from "@/main/tray-icon";
import {
	createChatWindow,
	createControlWindow,
	type Pages,
	pageUrl,
} from "@/main/windows";
import {
	type AdapterView,
	type ControlState,
	IPC,
	type Result,
} from "@/shared/ipc";

const customUserData = process.env.ORGOS_DESKTOP_USER_DATA;
if (customUserData) app.setPath("userData", path.resolve(customUserData));

const HOME = homedir();
const USER_DATA = app.getPath("userData");
const PAGES_DIR = path.join(app.getAppPath(), "dist", "app");
const pages: Pages = {
	dir: PAGES_DIR,
	setup: path.join(PAGES_DIR, "setup.html"),
	offline: path.join(PAGES_DIR, "offline.html"),
	control: path.join(PAGES_DIR, "control.html"),
	chatPreload: path.join(PAGES_DIR, "preload-chat.cjs"),
	controlPreload: path.join(PAGES_DIR, "preload-control.cjs"),
};
const RUNNER_BINARY = app.isPackaged
	? path.join(
			process.resourcesPath,
			"runner",
			runnerBinaryName(process.platform),
		)
	: path.join(
			app.getAppPath(),
			"dist",
			"runner",
			runnerBinaryName(process.platform),
		);

const settings = new SettingsStore(path.join(USER_DATA, "settings.json"), HOME);
const runnerLog = new RotatingLog(path.join(USER_DATA, "logs", "runner.log"));
const paired = () => isPaired(process.env, HOME);

let loginPath: string | null = null;
let loginPathError: string | null = null;
const loginPathReady = resolveLoginPath({
	shell: process.env.SHELL || "/bin/zsh",
	currentPath: process.env.PATH,
	run: runShell,
}).then((r) => {
	loginPath = r.path;
	loginPathError = r.error;
	return r.path;
});

const supervisor = new RunnerSupervisor({
	isPaired: paired,
	onLog: (line) => runnerLog.write(`${line}\n`),
	spawn: (hooks) => {
		const s = settings.get();
		return spawnRunner(
			{
				binary: RUNNER_BINARY,
				args: serveArgs(s.workspace, adaptersFlag(s.adapters)),
				env: runnerEnv(process.env, loginPath ?? process.env.PATH ?? ""),
				cwd: HOME,
			},
			hooks,
		);
	},
});

const RUNNER_PID_FILE = path.join(USER_DATA, "runner.pid");
let writtenPid: number | null = null;
supervisor.subscribe((s) => {
	if (s.pid === writtenPid) return;
	writtenPid = s.pid;
	writeRunnerPid(RUNNER_PID_FILE, s.pid);
});

let chatWindow: BrowserWindow | null = null;
let controlWindow: BrowserWindow | null = null;
let quitting = false;
let quitPending: { busy: number } | null = null;
let blockerId: number | null = null;

function serverOrigin(): string | null {
	return settings.get().serverUrl;
}

function chatTarget(): string {
	return serverOrigin() ?? pageUrl(pages.setup);
}

function showChat(): void {
	if (!chatWindow || chatWindow.isDestroyed()) {
		chatWindow = createChatWindow({
			pages,
			stateFile: path.join(USER_DATA, "window-state.json"),
			serverOrigin,
			hideOnClose: () => !quitting,
		});
		void chatWindow.loadURL(chatTarget());
		return;
	}
	if (chatWindow.isMinimized()) chatWindow.restore();
	chatWindow.show();
	chatWindow.focus();
}

function showControl(): void {
	if (!controlWindow || controlWindow.isDestroyed()) {
		controlWindow = createControlWindow(pages);
		controlWindow.on("closed", () => {
			controlWindow = null;
		});
		return;
	}
	controlWindow.show();
	controlWindow.focus();
}

function adapterViews(): AdapterView[] {
	const dev = process.env.ORGOS_DEV === "1";
	const enabled = settings.get().adapters;
	const searchPath = loginPath ?? process.env.PATH ?? "";
	return ACP_ADAPTERS.filter((a) => dev || !a.devOnly).map((a) => ({
		id: a.id,
		label: a.label,
		note: a.note,
		missing: a.requires.filter((bin) => !findExecutable(bin, searchPath)),
		enabled: enabled === null || enabled.includes(a.id),
	}));
}

function controlState(): ControlState {
	const status = supervisor.status;
	const phase = phaseOf(status);
	return {
		settings: settings.get(),
		phase,
		phaseLabel: PHASE_LABEL[phase],
		status,
		paired: paired(),
		adapters: adapterViews(),
		logFile: runnerLog.file,
		loginPathError,
		quitPending,
		defaultDeviceName: hostname()
			.replace(/\.local$/, "")
			.slice(0, 40),
		appVersion: app.getVersion(),
	};
}

const tray = createTray({
	openChat: showChat,
	openControl: showControl,
	startRunner: () => void startRunner(),
	stopRunner: () => void supervisor.stop(),
	setOpenAtLogin: (on) => applyOpenAtLogin(on),
	quit: () => requestQuit(),
});

let lastPhase: string | null = null;
function broadcast(): void {
	const state = controlState();
	tray.update(state);
	if (state.phase !== lastPhase) {
		lastPhase = state.phase;
		console.log(
			`[orgos] runner ${state.phase} process=${state.status.process} pid=${state.status.pid ?? "-"}`,
		);
	}
	const keepAwake = supervisor.wantsRunning;
	if (keepAwake && blockerId === null)
		blockerId = powerSaveBlocker.start("prevent-app-suspension");
	if (!keepAwake && blockerId !== null) {
		powerSaveBlocker.stop(blockerId);
		blockerId = null;
	}
	if (controlWindow && !controlWindow.isDestroyed())
		controlWindow.webContents.send(IPC.state, state);
}
supervisor.subscribe(broadcast);

async function startRunner(): Promise<void> {
	await loginPathReady;
	if (!paired()) {
		supervisor.refreshPaired();
		showControl();
		return;
	}
	supervisor.start();
}

function applyOpenAtLogin(on: boolean): void {
	app.setLoginItemSettings({ openAtLogin: on });
	settings.update({ openAtLogin: on });
	broadcast();
}

function requestQuit(): void {
	const busy = busyCount(supervisor.status);
	if (busy > 0) {
		quitPending = { busy };
		showControl();
		broadcast();
		return;
	}
	void quitNow();
}

async function quitNow(): Promise<void> {
	quitting = true;
	quitPending = null;
	await supervisor.stop();
	// 可能正处在一次被 before-quit 拦下的退出流程里：等它结束再发起新的退出，否则会被吞掉。
	setImmediate(() => app.quit());
}

/** 规范化用户输入的服务器地址，并确认它是一台 orgos 服务端（/healthz 返回 200）。 */
async function checkServer(
	input: unknown,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
	const url = typeof input === "string" ? normalizeServerUrl(input) : null;
	if (!url)
		return { ok: false, message: "请输入 http:// 或 https:// 开头的地址" };
	try {
		const res = await fetch(new URL("/healthz", url), {
			signal: AbortSignal.timeout(5_000),
		});
		if (res.ok) return { ok: true, url };
		return {
			ok: false,
			message: `${url} 不像是 orgos 服务器（HTTP ${res.status}）`,
		};
	} catch {
		return { ok: false, message: `连不上 ${url}` };
	}
}

function fromControl(event: IpcMainInvokeEvent): boolean {
	return !!controlWindow && event.sender === controlWindow.webContents;
}

/** 只接受控制窗口发来的调用。 */
function handleControl(
	channel: string,
	fn: (...args: unknown[]) => Promise<Result> | Result,
): void {
	ipcMain.handle(channel, async (event, ...args: unknown[]) => {
		if (!fromControl(event)) return { ok: false, message: "无权调用" };
		try {
			const r = await fn(...args);
			broadcast();
			return r;
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	});
}

function registerIpc(): void {
	const fromChat = (event: IpcMainEvent | IpcMainInvokeEvent) =>
		!!chatWindow && event.sender === chatWindow.webContents;

	ipcMain.on(IPC.setBadge, (event, count: unknown) => {
		if (!fromChat(event)) return;
		if (typeof count === "number" && Number.isInteger(count) && count >= 0)
			app.setBadgeCount(count);
	});
	ipcMain.on(IPC.focus, (event) => {
		if (fromChat(event)) showChat();
	});
	ipcMain.handle(
		IPC.saveServer,
		async (event, input: unknown): Promise<Result> => {
			if (
				!fromChat(event) ||
				event.sender.getURL().split(/[?#]/)[0] !== pageUrl(pages.setup)
			)
				return { ok: false, message: "无权调用" };
			const checked = await checkServer(input);
			if (!checked.ok) return checked;
			const url = checked.url;
			settings.update({ serverUrl: url });
			void chatWindow?.loadURL(url);
			broadcast();
			return { ok: true };
		},
	);

	ipcMain.handle(IPC.getState, (event) =>
		fromControl(event) ? controlState() : null,
	);

	handleControl(IPC.setServer, async (input) => {
		const checked = await checkServer(input);
		if (!checked.ok) return checked;
		const url = checked.url;
		settings.update({ serverUrl: url });
		if (chatWindow && !chatWindow.isDestroyed()) void chatWindow.loadURL(url);
		return { ok: true, message: "已保存" };
	});

	handleControl(IPC.pair, async (code, name) => {
		const server = serverOrigin();
		if (!server) return { ok: false, message: "先填写服务器地址" };
		if (typeof code !== "string" || !code.trim())
			return { ok: false, message: "请输入配对码" };
		if (typeof name !== "string" || !name.trim())
			return { ok: false, message: "请输入设备名" };
		await loginPathReady;
		const wasRunning = supervisor.wantsRunning;
		if (wasRunning) await supervisor.stop();
		const r = await runOnce(
			{
				binary: RUNNER_BINARY,
				args: pairArgs(code, server, name),
				env: runnerEnv(process.env, loginPath ?? ""),
				cwd: HOME,
			},
			30_000,
		);
		for (const line of `${r.stdout}${r.stderr}`.split("\n"))
			if (line.trim()) runnerLog.write(`${line}\n`);
		const outcome = pairOutcome(r.code, r.stdout, r.stderr);
		supervisor.refreshPaired();
		if (outcome.ok || wasRunning) await startRunner();
		return outcome;
	});

	handleControl(IPC.unpair, async () => {
		const parent = controlWindow;
		if (!parent) return { ok: false, message: "控制窗口已关闭" };
		const { response } = await dialog.showMessageBox(parent, {
			type: "warning",
			buttons: ["解除配对", "取消"],
			defaultId: 1,
			cancelId: 1,
			message: "解除本机配对？",
			detail:
				"会停止 Runner 并删除本机的配对信息。服务端的设备记录仍在，吊销请到网页的设备页操作。",
		});
		if (response !== 0) return { ok: false, message: "已取消" };
		await supervisor.stop();
		removePairing(process.env, HOME);
		supervisor.refreshPaired();
		return { ok: true, message: "已解除本机配对" };
	});

	handleControl(IPC.chooseWorkspace, async () => {
		const parent = controlWindow;
		if (!parent) return { ok: false, message: "控制窗口已关闭" };
		const r = await dialog.showOpenDialog(parent, {
			title: "选择 Runner 的工作目录",
			defaultPath: settings.get().workspace,
			properties: ["openDirectory", "createDirectory"],
		});
		const dir = r.filePaths[0];
		if (r.canceled || !dir) return { ok: false, message: "已取消" };
		settings.update({ workspace: dir });
		if (supervisor.wantsRunning) await supervisor.restart();
		return { ok: true };
	});

	handleControl(IPC.setAdapters, async (ids) => {
		const known = new Set(ACP_ADAPTERS.map((a) => a.id));
		if (
			ids !== null &&
			!(
				Array.isArray(ids) &&
				ids.every((id) => typeof id === "string" && known.has(id))
			)
		)
			return { ok: false, message: "适配器不合法" };
		settings.update({ adapters: ids as string[] | null });
		if (supervisor.wantsRunning) await supervisor.restart();
		return { ok: true };
	});

	handleControl(IPC.setAutoStart, (on) => {
		settings.update({ autoStartRunner: on === true });
		return { ok: true };
	});
	handleControl(IPC.setOpenAtLogin, (on) => {
		applyOpenAtLogin(on === true);
		return { ok: true };
	});
	handleControl(IPC.start, async () => {
		await startRunner();
		return { ok: true };
	});
	handleControl(IPC.stop, async () => {
		await supervisor.stop();
		return { ok: true };
	});
	handleControl(IPC.restart, async () => {
		await loginPathReady;
		await supervisor.restart();
		return { ok: true };
	});
	handleControl(IPC.openLog, async () => {
		runnerLog.write("");
		const err = await shell.openPath(runnerLog.file);
		return err ? { ok: false, message: err } : { ok: true };
	});
	handleControl(IPC.confirmQuit, () => {
		void quitNow();
		return { ok: true };
	});
	handleControl(IPC.cancelQuit, () => {
		quitPending = null;
		return { ok: true };
	});
}

function buildAppMenu(): void {
	const isMac = process.platform === "darwin";
	const template: Electron.MenuItemConstructorOptions[] = [
		...(isMac
			? [
					{
						label: app.name,
						submenu: [
							{ role: "about" as const },
							{ type: "separator" as const },
							{ label: "Runner 控制…", click: showControl },
							{ type: "separator" as const },
							{ role: "hide" as const },
							{ role: "hideOthers" as const },
							{ role: "unhide" as const },
							{ type: "separator" as const },
							{
								label: "退出 orgos",
								accelerator: "Command+Q",
								click: requestQuit,
							},
						],
					},
				]
			: []),
		{ role: "editMenu" },
		{ role: "viewMenu" },
		{ role: "windowMenu" },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", showChat);
	app.on("activate", showChat);
	app.on("window-all-closed", () => {
		// 关窗不退出：菜单栏图标与 Runner 继续工作。
	});
	app.on("before-quit", (event) => {
		if (quitting) return;
		event.preventDefault();
		requestQuit();
	});

	for (const signal of ["SIGTERM", "SIGINT"] as const)
		process.on(signal, () => void quitNow());

	void app.whenReady().then(async () => {
		const orphan = killOrphanRunner(RUNNER_PID_FILE, RUNNER_BINARY);
		if (orphan !== null)
			runnerLog.write(
				`${new Date().toISOString()} warn desktop.orphan_killed ${JSON.stringify({ pid: orphan })}\n`,
			);
		session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
			cb(permission === "notifications"),
		);
		session.defaultSession.setPermissionCheckHandler(
			(_wc, permission) => permission === "notifications",
		);
		buildAppMenu();
		registerIpc();
		tray.create();
		broadcast();
		showChat();
		await loginPathReady;
		if (settings.get().autoStartRunner && paired()) supervisor.start();
		broadcast();
	});
}
