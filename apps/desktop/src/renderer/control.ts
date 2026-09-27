/**
 * Runner 控制窗口：展示主进程推来的状态，把操作经 `window.orgosControl` 交给主进程。
 */
import type { ControlState, OrgosControlApi, Result } from "@/shared/ipc";

const api = (window as unknown as { orgosControl: OrgosControlApi })
	.orgosControl;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
	const node = document.getElementById(id);
	if (!node) throw new Error(`页面缺少 #${id}`);
	return node as T;
}

const LINK_LABEL: Record<ControlState["status"]["link"]["link"], string> = {
	starting: "启动中",
	connecting: "连接中",
	connected: "已连接",
	reconnecting: "断开，重连中",
};

const PROCESS_LABEL: Record<ControlState["status"]["process"], string> = {
	unpaired: "未配对",
	stopped: "已停止",
	running: "运行中",
	restarting: "意外退出，等待重启",
	stopping: "正在停止",
};

function formatTime(iso: string | null): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN");
}

function show(target: HTMLElement, r: Result): void {
	target.dataset.tone = r.ok ? "" : "error";
	target.textContent = r.message ?? "";
}

async function run(
	target: HTMLElement,
	action: () => Promise<Result>,
	busyText?: string,
): Promise<Result> {
	if (busyText) {
		target.dataset.tone = "";
		target.textContent = busyText;
	}
	const r = await action();
	show(target, r);
	return r;
}

let current: ControlState | null = null;
let deviceNameTouched = false;

function render(state: ControlState): void {
	current = state;
	const { status, settings } = state;
	const running = status.process !== "stopped" && status.process !== "unpaired";

	el("phase-dot").dataset.phase = state.phase;
	el("phase-label").textContent = state.phaseLabel;

	el("quit").hidden = state.quitPending === null;
	if (state.quitPending)
		el("quit-text").textContent =
			`Runner 还有 ${state.quitPending.busy} 项进行中的任务，退出会中断它们。`;

	el("fact-link").textContent =
		status.process === "running" ? LINK_LABEL[status.link.link] : "—";
	el("fact-connected").textContent = formatTime(status.link.lastConnectedAt);
	el("fact-busy").textContent =
		status.process === "running"
			? `设备操作 ${status.link.jobs} 项 · 外部助手会话 ${status.link.sessions} 个`
			: "—";
	const restarts =
		status.restarts > 0 ? `，已自动重启 ${status.restarts} 次` : "";
	const pid = status.pid !== null ? `（进程 ${status.pid}）` : "";
	el("fact-process").textContent =
		`${PROCESS_LABEL[status.process]}${pid}${restarts}`;
	el("fact-problem").textContent = status.link.lastProblem ?? "—";

	const start = el<HTMLButtonElement>("start");
	start.disabled = running || !state.paired;
	start.classList.toggle("primary", !start.disabled);
	el<HTMLButtonElement>("stop").disabled = !running;
	el<HTMLButtonElement>("restart").disabled = !state.paired;

	const server = el<HTMLInputElement>("server");
	if (document.activeElement !== server)
		server.value = settings.serverUrl ?? "";

	el("paired").hidden = !state.paired;
	el("pair-form").hidden = state.paired;
	const name = el<HTMLInputElement>("device-name");
	if (!deviceNameTouched && !name.value) name.value = state.defaultDeviceName;

	el("workspace").textContent = settings.workspace;

	const pathError = el("path-error");
	pathError.hidden = state.loginPathError === null;
	pathError.textContent = state.loginPathError
		? `读取登录 shell 的 PATH 失败（${state.loginPathError}），检测结果可能不准。`
		: "";
	renderAdapters(state);

	el<HTMLInputElement>("auto-start").checked = settings.autoStartRunner;
	el<HTMLInputElement>("open-at-login").checked = settings.openAtLogin;
	el("footer").textContent =
		`日志：${state.logFile} · 版本 ${state.appVersion}`;
}

function renderAdapters(state: ControlState): void {
	el("adapters").replaceChildren(
		...state.adapters.map((a) => {
			const row = document.createElement("label");
			row.className = "adapter";
			const toggle = document.createElement("input");
			toggle.type = "checkbox";
			toggle.checked = a.enabled;
			toggle.dataset.id = a.id;
			toggle.addEventListener("change", onAdaptersChanged);
			const text = document.createElement("div");
			const name = document.createElement("div");
			name.className = "name";
			name.textContent = a.label;
			const tag = document.createElement("span");
			tag.className = "tag";
			tag.textContent =
				a.missing.length === 0
					? "已安装"
					: `未安装：缺少 ${a.missing.join("、")}`;
			name.append(tag);
			const note = document.createElement("p");
			note.className = "muted";
			note.textContent = a.note;
			text.append(name, note);
			row.append(toggle, text);
			return row;
		}),
	);
}

function onAdaptersChanged(): void {
	if (!current) return;
	const boxes = [
		...el("adapters").querySelectorAll<HTMLInputElement>(
			"input[type=checkbox]",
		),
	];
	const ids = boxes.filter((b) => b.checked).map((b) => b.dataset.id ?? "");
	const all = ids.length === current.adapters.length;
	void api.setAdapters(all ? null : ids);
}

el("start").addEventListener(
	"click",
	() => void run(el("run-message"), api.start),
);
el("stop").addEventListener(
	"click",
	() => void run(el("run-message"), api.stop, "正在停止…"),
);
el("restart").addEventListener(
	"click",
	() => void run(el("run-message"), api.restart, "正在重启…"),
);
el("open-log").addEventListener(
	"click",
	() => void run(el("run-message"), api.openLog),
);

el("server-form").addEventListener("submit", (event) => {
	event.preventDefault();
	void run(
		el("server-message"),
		() => api.setServer(el<HTMLInputElement>("server").value),
		"正在检查服务器…",
	);
});

el("device-name").addEventListener("input", () => {
	deviceNameTouched = true;
});

el("pair-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const code = el<HTMLInputElement>("code");
	const r = await run(
		el("pair-message"),
		() => api.pair(code.value, el<HTMLInputElement>("device-name").value),
		"正在配对…",
	);
	if (r.ok) code.value = "";
});

el("unpair").addEventListener(
	"click",
	() => void run(el("pair-message"), api.unpair),
);
el("choose-workspace").addEventListener(
	"click",
	() => void api.chooseWorkspace(),
);
el("auto-start").addEventListener(
	"change",
	(e) => void api.setAutoStart((e.target as HTMLInputElement).checked),
);
el("open-at-login").addEventListener(
	"change",
	(e) => void api.setOpenAtLogin((e.target as HTMLInputElement).checked),
);
el("quit-confirm").addEventListener("click", () => void api.confirmQuit());
el("quit-cancel").addEventListener("click", () => void api.cancelQuit());

api.onState(render);
void api.getState().then(render);
