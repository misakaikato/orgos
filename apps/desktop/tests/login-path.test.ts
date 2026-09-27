import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	findExecutable,
	loginShellCommand,
	mergePaths,
	PATH_MARK,
	parseLoginPath,
	resolveLoginPath,
} from "@/main/login-path";
import { runShell } from "@/main/runner-process";

describe("登录 shell 的 PATH", () => {
	it("以登录交互 shell 打印带标记的 PATH", () => {
		const { command, args } = loginShellCommand("/bin/zsh");
		expect(command).toBe("/bin/zsh");
		expect(args[0]).toBe("-ilc");
		expect(args[1]).toContain(PATH_MARK);
		expect(args[1]).toContain('"$PATH"');
	});

	it("从夹杂启动脚本输出的内容里取出 PATH", () => {
		const out = `欢迎回来\nnvm: using 22\n${PATH_MARK}/opt/homebrew/bin:/usr/bin${PATH_MARK}\n`;
		expect(parseLoginPath(out)).toBe("/opt/homebrew/bin:/usr/bin");
		expect(parseLoginPath("没有标记")).toBeNull();
		expect(parseLoginPath(`${PATH_MARK}/usr/bin`)).toBeNull();
		expect(parseLoginPath(`${PATH_MARK}${PATH_MARK}`)).toBeNull();
	});

	it("合并 PATH：保持顺序、去重、去空段", () => {
		expect(mergePaths("/a:/b::/c", null, "/b:/d", undefined)).toBe(
			"/a:/b:/c:/d",
		);
		expect(mergePaths()).toBe("");
	});

	it("登录 shell 的在前，本进程的在后", async () => {
		const r = await resolveLoginPath({
			shell: "/bin/zsh",
			currentPath: "/usr/bin:/bin",
			run: async () => `${PATH_MARK}/opt/homebrew/bin:/usr/bin${PATH_MARK}`,
		});
		expect(r).toEqual({ path: "/opt/homebrew/bin:/usr/bin:/bin", error: null });
	});

	it("shell 失败时只用本进程的 PATH，并给出原因", async () => {
		const r = await resolveLoginPath({
			shell: "/bin/nope",
			currentPath: "/usr/bin",
			run: async () => {
				throw new Error("spawn /bin/nope ENOENT");
			},
		});
		expect(r).toEqual({ path: "/usr/bin", error: "spawn /bin/nope ENOENT" });
		const empty = await resolveLoginPath({
			shell: "/bin/sh",
			currentPath: "/usr/bin",
			run: async () => "",
		});
		expect(empty.error).toBe("登录 shell 的输出里没有 PATH");
	});

	it("真实的 /bin/sh 登录 shell 能给出 PATH", async () => {
		const r = await resolveLoginPath({
			shell: "/bin/sh",
			currentPath: undefined,
			run: runShell,
		});
		expect(r.error).toBeNull();
		expect(r.path.split(":")).toContain("/usr/bin");
	});
});

describe("在 PATH 上找可执行文件", () => {
	it("按 PATH 顺序找到第一个可执行的", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "orgos-desktop-path-"));
		try {
			const a = path.join(dir, "a");
			const b = path.join(dir, "b");
			mkdirSync(a);
			mkdirSync(b);
			writeFileSync(path.join(a, "tool"), "not executable");
			writeFileSync(path.join(b, "tool"), "#!/bin/sh\n");
			chmodSync(path.join(b, "tool"), 0o755);
			mkdirSync(path.join(a, "dir-tool"));
			expect(findExecutable("tool", `${a}:${b}`)).toBe(path.join(b, "tool"));
			expect(findExecutable("dir-tool", a)).toBeNull();
			expect(findExecutable("missing", `${a}:${b}`)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("Windows 依次试扩展名", () => {
		const seen: string[] = [];
		const hit = findExecutable(
			"npx",
			"/w",
			(f) => {
				seen.push(f);
				return f.endsWith(".CMD");
			},
			[".EXE", ".CMD"],
		);
		expect(seen).toEqual(["/w/npx.EXE", "/w/npx.CMD"]);
		expect(hit).toBe("/w/npx.CMD");
	});
});
