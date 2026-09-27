/**
 * 第一次启动的服务器地址页（在聊天窗口里打开，保存后聊天窗口改为加载该地址）。
 */
import { DEFAULT_SERVER_URL } from "@/shared/defaults";
import type { OrgosDesktopApi } from "@/shared/ipc";

const bridge = (window as unknown as { orgosDesktop?: OrgosDesktopApi })
	.orgosDesktop;

const form = document.getElementById("form") as HTMLFormElement;
const input = document.getElementById("server") as HTMLInputElement;
const message = document.getElementById("message") as HTMLElement;

input.value = DEFAULT_SERVER_URL;
input.focus();
input.select();

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (!bridge?.saveServer) return;
	message.dataset.tone = "";
	message.textContent = "正在连接…";
	const r = await bridge.saveServer(input.value);
	if (!r.ok) {
		message.dataset.tone = "error";
		message.textContent = r.message;
	}
});
