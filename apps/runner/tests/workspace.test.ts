import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	OUTPUT_TRUNCATED_NOTE,
	RUNNER_OUTPUT_MAX_BYTES,
} from "@orgos/protocol";
import { execCommand, openWorkspace, runCapability } from "@/workspace";

let base: string;
let ws: string;
let outside: string;

beforeAll(async () => {
	base = await mkdtemp(path.join(tmpdir(), "orgos-runner-test-"));
	ws = await openWorkspace(path.join(base, "ws"));
	outside = path.join(base, "outside");
	await mkdir(outside);
	await writeFile(path.join(outside, "secret.txt"), "top secret");
	await writeFile(path.join(ws, "a.txt"), "hello a");
	await mkdir(path.join(ws, "sub"));
	await symlink(path.join(outside, "secret.txt"), path.join(ws, "leak.txt"));
	await symlink(outside, path.join(ws, "outdir"));
	await symlink(path.join(outside, "nope.txt"), path.join(ws, "dangling.txt"));
});

afterAll(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("路径限制在工作目录内", () => {
	it("列目录与读文件：目录在前、带大小", async () => {
		const list = await runCapability(ws, "fs.list", { path: "." });
		expect(list.ok).toBe(true);
		expect(list.output.split("\n")[0]).toMatch(/\/$/);
		expect(list.output).toContain("a.txt  7 B");
		const read = await runCapability(ws, "fs.read", { path: "a.txt" });
		expect(read).toEqual({ ok: true, output: "hello a" });
	});

	it("../ 越界 → 拒绝", async () => {
		const r = await runCapability(ws, "fs.read", {
			path: "../outside/secret.txt",
		});
		expect(r.ok).toBe(false);
		expect(r.output).toContain("超出工作目录");
		expect(r.output).not.toContain("top secret");
	});

	it("绝对路径指向工作目录外 → 拒绝；指向工作目录内 → 允许", async () => {
		const out = await runCapability(ws, "fs.read", {
			path: path.join(outside, "secret.txt"),
		});
		expect(out.ok).toBe(false);
		expect(out.output).not.toContain("top secret");
		const inside = await runCapability(ws, "fs.read", {
			path: path.join(ws, "a.txt"),
		});
		expect(inside.ok).toBe(true);
	});

	it("符号链接逃逸（文件与目录）→ 拒绝读、列、写", async () => {
		const read = await runCapability(ws, "fs.read", { path: "leak.txt" });
		expect(read.ok).toBe(false);
		expect(read.output).not.toContain("top secret");
		const list = await runCapability(ws, "fs.list", { path: "outdir" });
		expect(list.ok).toBe(false);
		const writeThrough = await runCapability(ws, "fs.write", {
			path: "leak.txt",
			content: "pwned",
		});
		expect(writeThrough.ok).toBe(false);
		const writeIntoDir = await runCapability(ws, "fs.write", {
			path: "outdir/new.txt",
			content: "pwned",
		});
		expect(writeIntoDir.ok).toBe(false);
		const dangling = await runCapability(ws, "fs.write", {
			path: "dangling.txt",
			content: "pwned",
		});
		expect(dangling.ok).toBe(false);
		expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe(
			"top secret",
		);
		await expect(readFile(path.join(outside, "nope.txt"))).rejects.toThrow();
	});

	it("写入：可建子目录，写到工作目录内", async () => {
		const r = await runCapability(ws, "fs.write", {
			path: "notes/deep/b.txt",
			content: "你好",
		});
		expect(r).toEqual({
			ok: true,
			output: "已写入 notes/deep/b.txt（6 字节）",
		});
		expect(await readFile(path.join(ws, "notes/deep/b.txt"), "utf8")).toBe(
			"你好",
		);
	});

	it("参数不合法 → 失败结果而非异常", async () => {
		const r = await runCapability(ws, "fs.read", { nope: 1 });
		expect(r).toEqual({ ok: false, output: "参数不合法" });
	});
});

describe("shell.exec", () => {
	it("在工作目录下执行，合并 stdout 与 stderr，带退出码", async () => {
		const r = await runCapability(ws, "shell.exec", {
			command: "pwd; echo out; echo err 1>&2; exit 3",
		});
		expect(r.ok).toBe(true);
		expect(r.exitCode).toBe(3);
		expect(r.output).toContain(ws);
		expect(r.output).toContain("out");
		expect(r.output).toContain("err");
	});

	it("输出超过 64KB 截断并注明", async () => {
		const r = await execCommand(ws, "head -c 200000 /dev/zero | tr '\\0' x");
		expect(r.ok).toBe(true);
		expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(
			RUNNER_OUTPUT_MAX_BYTES,
		);
		expect(r.output.endsWith(OUTPUT_TRUNCATED_NOTE)).toBe(true);
	});

	it("超时整组杀掉（含后台的孙进程），返回失败", async () => {
		const started = Date.now();
		const r = await execCommand(ws, "echo begin; sleep 30; echo never", 300);
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(r.ok).toBe(false);
		expect(r.output).toContain("begin");
		expect(r.output).toContain("已终止");
		expect(r.output).not.toContain("never");
	});

	it("多个命令并行执行", async () => {
		const started = Date.now();
		const results = await Promise.all(
			[1, 2, 3].map((i) =>
				runCapability(ws, "shell.exec", { command: `sleep 0.5; echo ${i}` }),
			),
		);
		expect(Date.now() - started).toBeLessThan(1_400);
		expect(results.map((r) => r.output.trim())).toEqual(["1", "2", "3"]);
	});
});
