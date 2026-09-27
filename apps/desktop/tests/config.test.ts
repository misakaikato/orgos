import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideNavigation } from "@/main/navigation";
import {
	pairArgs,
	pairOutcome,
	runnerConfigFile,
	runnerEnv,
	serveArgs,
} from "@/main/runner-cli";
import {
	adaptersFlag,
	defaultSettings,
	normalizeServerUrl,
	parseSettings,
	SettingsStore,
} from "@/main/settings";
import { restoreBounds } from "@/main/window-state";

describe("服务器地址", () => {
	it("规范化为 origin，省略协议按 http", () => {
		expect(normalizeServerUrl(" localhost:8930 ")).toBe(
			"http://localhost:8930",
		);
		expect(normalizeServerUrl("https://orgos.example.com/app?x=1")).toBe(
			"https://orgos.example.com",
		);
		expect(normalizeServerUrl("http://127.0.0.1:8960/")).toBe(
			"http://127.0.0.1:8960",
		);
	});

	it("拒绝空值与非 http(s)", () => {
		for (const bad of [
			"",
			"   ",
			"ftp://x",
			"file:///etc",
			"javascript:alert(1)",
			"http://",
		])
			expect(normalizeServerUrl(bad)).toBeNull();
	});
});

describe("设置", () => {
	it("缺的与不合法的字段取默认值", () => {
		const d = defaultSettings("/Users/me");
		expect(d.workspace).toBe("/Users/me/orgos-workspace");
		expect(parseSettings(null, "/Users/me")).toEqual(d);
		expect(
			parseSettings(
				{
					serverUrl: "localhost:8930",
					workspace: "relative/dir",
					adapters: ["codex", "codex", 3],
					autoStartRunner: "yes",
					openAtLogin: true,
				},
				"/Users/me",
			),
		).toEqual({ ...d, serverUrl: "http://localhost:8930", openAtLogin: true });
		expect(
			parseSettings({ adapters: ["codex", "codex"] }, "/h").adapters,
		).toEqual(["codex"]);
	});

	it("写入后可读回", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "orgos-desktop-settings-"));
		try {
			const file = path.join(dir, "sub", "settings.json");
			const store = new SettingsStore(file, "/h");
			store.update({ serverUrl: "http://localhost:8960", adapters: [] });
			expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
				serverUrl: "http://localhost:8960",
				adapters: [],
			});
			expect(new SettingsStore(file, "/h").get().serverUrl).toBe(
				"http://localhost:8960",
			);
			writeFileSync(file, "{broken");
			expect(new SettingsStore(file, "/h").get()).toEqual(
				defaultSettings("/h"),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("适配器开关换成 serve 的 --adapters 取值", () => {
		expect(adaptersFlag(null)).toBeNull();
		expect(adaptersFlag([])).toBe("none");
		expect(adaptersFlag(["claude-code", "codex"])).toBe("claude-code,codex");
	});
});

describe("Runner 命令行", () => {
	it("配对文件位置与 Runner 同一规则", () => {
		expect(runnerConfigFile({}, "/Users/me")).toBe(
			"/Users/me/.orgos/runner.json",
		);
		expect(
			runnerConfigFile({ ORGOS_RUNNER_HOME: "/tmp/rh" }, "/Users/me"),
		).toBe("/tmp/rh/runner.json");
	});

	it("pair 与 serve 的参数", () => {
		expect(
			pairArgs(" ABCD-EFGH ", "http://localhost:8930", " 我的电脑 "),
		).toEqual([
			"pair",
			"ABCD-EFGH",
			"--server",
			"http://localhost:8930",
			"--name",
			"我的电脑",
		]);
		expect(serveArgs("/w", null)).toEqual(["serve", "--workspace", "/w"]);
		expect(serveArgs("/w", "none")).toEqual([
			"serve",
			"--workspace",
			"/w",
			"--adapters",
			"none",
		]);
	});

	it("子进程环境：登录 PATH、本机不走代理，其余继承", () => {
		const env = runnerEnv(
			{ HOME: "/h", PATH: "/usr/bin", HTTP_PROXY: "http://p" },
			"/opt/bin:/usr/bin",
		);
		expect(env).toEqual({
			HOME: "/h",
			PATH: "/opt/bin:/usr/bin",
			HTTP_PROXY: "http://p",
			NO_PROXY: "localhost,127.0.0.1",
			no_proxy: "localhost,127.0.0.1",
		});
	});

	it("pair 的结果：成功取标准输出，失败取最后一行非日志的报错", () => {
		expect(
			pairOutcome(0, "已配对“我的电脑”，配对信息写入 /x/runner.json\n", ""),
		).toEqual({
			ok: true,
			message: "已配对“我的电脑”，配对信息写入 /x/runner.json",
		});
		expect(
			pairOutcome(
				1,
				"",
				'2026-09-27T04:00:00.000Z info something {"a":1}\n配对码无效或已过期\n',
			),
		).toEqual({ ok: false, message: "配对码无效或已过期" });
		expect(pairOutcome(null, "", "")).toEqual({
			ok: false,
			message: "配对失败（退出码 无）",
		});
	});
});

describe("聊天窗口的导航", () => {
	const setup =
		"file:///Applications/orgos.app/Contents/Resources/app.asar/dist/app/setup.html";
	it("服务器源内放行，外部 http(s) 交给系统浏览器，其余拒绝", () => {
		const origin = "http://localhost:8930";
		expect(decideNavigation("http://localhost:8930/c/1", origin, [setup])).toBe(
			"allow",
		);
		expect(decideNavigation("http://localhost:8931/", origin, [setup])).toBe(
			"external",
		);
		expect(decideNavigation("https://github.com/x", origin, [setup])).toBe(
			"external",
		);
		expect(decideNavigation("mailto:a@b.c", origin, [setup])).toBe("deny");
		expect(decideNavigation("javascript:alert(1)", origin, [setup])).toBe(
			"deny",
		);
		expect(decideNavigation("not a url", origin, [setup])).toBe("deny");
	});

	it("本地页面只放行登记过的那几个", () => {
		expect(decideNavigation(`${setup}?x=1#y`, null, [setup])).toBe("allow");
		expect(decideNavigation("file:///etc/passwd", null, [setup])).toBe("deny");
		expect(decideNavigation("http://localhost:8930/", null, [setup])).toBe(
			"external",
		);
	});
});

describe("窗口位置", () => {
	const screen = { x: 0, y: 0, width: 1440, height: 900 };
	it("没有保存过：默认大小，由系统居中", () => {
		expect(restoreBounds(null, [screen])).toEqual({
			bounds: { width: 1280, height: 820 },
			maximized: false,
		});
	});

	it("保存的位置在屏幕上：原样恢复", () => {
		const saved = { x: 100, y: 80, width: 1000, height: 700, maximized: true };
		expect(restoreBounds(saved, [screen])).toEqual({
			bounds: { x: 100, y: 80, width: 1000, height: 700 },
			maximized: true,
		});
	});

	it("保存的位置已不在任何屏幕上：只恢复大小；过小的尺寸抬到下限", () => {
		const saved = { x: 3000, y: 80, width: 200, height: 100, maximized: false };
		expect(restoreBounds(saved, [screen])).toEqual({
			bounds: { width: 420, height: 560 },
			maximized: false,
		});
	});
});
