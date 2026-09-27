/**
 * 菜单栏图标：图标与提示文字随 Runner 状态变化；菜单里是打开聊天、Runner 控制、
 * 启动 / 停止 Runner、开机自启与退出。
 */
import { Menu, nativeImage, Tray } from "electron";
import type { RunnerPhase } from "@/main/supervisor";
import { TRAY_POINTS, trayBitmap } from "@/main/tray-icon";
import type { ControlState } from "@/shared/ipc";

export type TrayActions = {
	openChat: () => void;
	openControl: () => void;
	startRunner: () => void;
	stopRunner: () => void;
	setOpenAtLogin: (on: boolean) => void;
	quit: () => void;
};

function iconFor(phase: RunnerPhase): Electron.NativeImage {
	const image = nativeImage.createFromBitmap(trayBitmap(phase, 1), {
		width: TRAY_POINTS,
		height: TRAY_POINTS,
		scaleFactor: 1,
	});
	image.addRepresentation({
		scaleFactor: 2,
		width: TRAY_POINTS * 2,
		height: TRAY_POINTS * 2,
		buffer: trayBitmap(phase, 2),
	});
	image.setTemplateImage(true);
	return image;
}

export function createTray(actions: TrayActions): {
	create: () => void;
	update: (state: ControlState) => void;
} {
	let tray: Tray | null = null;
	const icons = new Map<RunnerPhase, Electron.NativeImage>();
	const icon = (phase: RunnerPhase) => {
		let image = icons.get(phase);
		if (!image) {
			image = iconFor(phase);
			icons.set(phase, image);
		}
		return image;
	};
	let shownPhase: RunnerPhase | null = null;

	const menuFor = (state: ControlState): Menu => {
		const running =
			state.status.process !== "stopped" && state.status.process !== "unpaired";
		const busy = state.status.link.jobs + state.status.link.sessions;
		return Menu.buildFromTemplate([
			{ label: `Runner：${state.phaseLabel}`, enabled: false },
			...(running && busy > 0
				? [{ label: `进行中 ${busy} 项`, enabled: false }]
				: []),
			{ type: "separator" },
			{ label: "打开 orgos", click: actions.openChat },
			{ label: "Runner 控制…", click: actions.openControl },
			{ type: "separator" },
			running
				? { label: "停止 Runner", click: actions.stopRunner }
				: state.paired
					? { label: "启动 Runner", click: actions.startRunner }
					: { label: "配对这台设备…", click: actions.openControl },
			{ type: "separator" },
			{
				label: "开机自启",
				type: "checkbox",
				checked: state.settings.openAtLogin,
				click: (item) => actions.setOpenAtLogin(item.checked),
			},
			{ type: "separator" },
			{ label: "退出 orgos", click: actions.quit },
		]);
	};

	let pending: ControlState | null = null;
	const apply = (state: ControlState) => {
		if (!tray) {
			pending = state;
			return;
		}
		if (state.phase !== shownPhase) {
			shownPhase = state.phase;
			tray.setImage(icon(state.phase));
		}
		tray.setToolTip(`orgos Runner：${state.phaseLabel}`);
		tray.setContextMenu(menuFor(state));
	};

	return {
		create: () => {
			if (tray) return;
			tray = new Tray(icon(pending?.phase ?? "stopped"));
			shownPhase = pending?.phase ?? "stopped";
			if (pending) apply(pending);
		},
		update: apply,
	};
}
