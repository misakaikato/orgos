/**
 * 开发启动：同时起服务端（8930，浏览器唯一入口）与内部 Next（3930）。
 * 任一进程退出即结束另一个；Ctrl+C 一并停止。
 *
 * 运行：bun run dev（已带 ORGOS_DEV=1 与 NO_PROXY）。
 */
const env = {
	...process.env,
	ORGOS_DEV: "1",
	NO_PROXY: "localhost,127.0.0.1",
	no_proxy: "localhost,127.0.0.1",
};

const root = new URL("../", import.meta.url).pathname;

const children = [
	Bun.spawn(["bun", "run", "--cwd", "apps/server", "dev"], {
		cwd: root,
		env,
		stdio: ["inherit", "inherit", "inherit"],
	}),
	Bun.spawn(["bun", "run", "--cwd", "apps/web", "dev"], {
		cwd: root,
		env,
		stdio: ["inherit", "inherit", "inherit"],
	}),
];

let stopping = false;
function stopAll(code: number): void {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill("SIGTERM");
	void Promise.all(children.map((c) => c.exited)).then(() =>
		process.exit(code),
	);
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
for (const child of children) {
	void child.exited.then((code) => stopAll(code ?? 1));
}
