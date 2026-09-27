/**
 * 聊天窗口加载服务器失败时显示的本地页：重试回到服务器，或去服务器地址页更换地址。
 */
const params = new URLSearchParams(location.search);
const server = params.get("server") ?? "";
const error = params.get("error") ?? "";

(document.getElementById("server") as HTMLElement).textContent = server;
(document.getElementById("error") as HTMLElement).textContent = error
	? `原因：${error}`
	: "";

document.getElementById("retry")?.addEventListener("click", () => {
	if (server) location.href = server;
});

document.getElementById("change")?.addEventListener("click", () => {
	const setup = new URL("setup.html", location.href);
	if (server) setup.searchParams.set("server", server);
	location.href = setup.href;
});
