/**
 * 真实起仓库内的 fake ACP agent：一个任务一个会话、追问复用同一会话、权限请求与回传、
 * fs 越界拒绝、终端先审批（本任务内始终允许）、取消即终止进程、子进程看不到被清洗的键。
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AcpUp, findAdapter, SCRUBBED_ENV_KEYS } from "@orgos/protocol";
import { AdapterRegistry } from "@/acp/adapters";
import { AcpManager } from "@/acp/session";
import { openWorkspace } from "@/workspace";

const TASK = "00000000-0000-4000-8000-000000000001";
const TASK2 = "00000000-0000-4000-8000-000000000002";

let base: string;
let ws: string;
let frames: AcpUp[];
let manager: AcpManager;

async function until<T>(
	what: string,
	fn: () => T | null | undefined | false,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
		await Bun.sleep(20);
	}
}

function texts(taskId: string): string {
	return frames
		.flatMap((f) =>
			f.t === "acp_event" && f.taskId === taskId && f.kind === "agent_text"
				? [(f.payload as { text: string }).text]
				: [],
		)
		.join("");
}

function turnEnds(taskId: string) {
	return frames.filter(
		(f): f is Extract<AcpUp, { t: "acp_turn_end" }> =>
			f.t === "acp_turn_end" && f.taskId === taskId,
	);
}

function permissions(taskId: string) {
	return frames.filter(
		(f): f is Extract<AcpUp, { t: "acp_permission" }> =>
			f.t === "acp_permission" && f.taskId === taskId,
	);
}

beforeAll(async () => {
	base = await mkdtemp(path.join(tmpdir(), "orgos-acp-test-"));
	ws = await openWorkspace(path.join(base, "ws"));
	await mkdir(path.join(ws, "proj"));
	await writeFile(path.join(ws, "proj", "hello.txt"), "你好\n");
	await writeFile(path.join(base, "secret.txt"), "top secret");
	const fake = findAdapter("fake");
	if (!fake) throw new Error("没有 fake 适配器");
	const adapters = new AdapterRegistry([fake]);
	await adapters.probeAll(ws, () => {});
	expect(adapters.statuses()).toEqual([
		expect.objectContaining({ id: "fake", available: true }),
	]);
	frames = [];
	// 模拟 Runner 进程环境里混进了凭据：子进程必须一个都看不到。
	for (const k of SCRUBBED_ENV_KEYS) process.env[k] = `leak-${k}`;
	manager = new AcpManager({
		runnerWorkspace: ws,
		adapters,
		send: (f) => frames.push(f),
	});
});

afterAll(async () => {
	manager.disposeAll();
	for (const k of SCRUBBED_ENV_KEYS) delete process.env[k];
	await rm(base, { recursive: true, force: true });
});

describe("一个任务一个 ACP 会话", () => {
	it("起会话：先记 ready（带外部会话 id），第一轮回显后结束", async () => {
		manager.handle({
			t: "acp_start",
			taskId: TASK,
			adapter: "fake",
			workspace: "proj",
			prompt: "列出文件",
		});
		expect(manager.running()).toEqual([TASK]);
		const [end] = await until("第一轮结束", () => {
			const e = turnEnds(TASK);
			return e.length === 1 ? e : null;
		});
		expect(end?.stopReason).toBe("end_turn");
		expect(end?.sessionId).toMatch(/^fake-/);
		const ready = frames.find((f) => f.t === "acp_event" && f.kind === "state");
		expect(ready).toMatchObject({
			payload: { state: "ready", sessionId: end?.sessionId },
		});
		expect(texts(TASK)).toContain("收到：列出文件。我是测试用的假助手。");
	});

	it("子进程的环境里没有 runner token、服务器地址与配置目录", () => {
		const line = texts(TASK)
			.split("\n")
			.find((l) => l.startsWith("环境变量："));
		expect(line).toBeDefined();
		const keys = (line ?? "").slice("环境变量：".length).split(",");
		expect(keys).toContain("PATH");
		for (const k of SCRUBBED_ENV_KEYS) expect(keys).not.toContain(k);
	});

	it("追问：同一会话", async () => {
		manager.handle({ t: "acp_prompt", taskId: TASK, prompt: "再来一次" });
		await until("第二轮结束", () => turnEnds(TASK).length === 2);
		const [a, b] = turnEnds(TASK);
		expect(b?.sessionId).toBe(a?.sessionId);
		expect(texts(TASK)).toContain("收到：再来一次。");
	});

	it("权限请求：本人所选的选项原样回给 agent，允许后才写入", async () => {
		manager.handle({
			t: "acp_prompt",
			taskId: TASK,
			prompt: "#perm out/a.txt|第一行",
		});
		const [perm] = await until("权限请求", () => {
			const p = permissions(TASK);
			return p.length === 1 ? p : null;
		});
		expect(perm?.source).toBe("agent");
		expect(perm?.toolCall.title).toBe("写入 out/a.txt");
		expect(perm?.options.map((o) => o.optionId)).toEqual([
			"allow",
			"allow_always",
			"reject",
		]);
		manager.handle({
			t: "acp_permission_reply",
			taskId: TASK,
			requestId: perm?.requestId ?? "",
			optionId: "allow",
		});
		await until("第三轮结束", () => turnEnds(TASK).length === 3);
		expect(await readFile(path.join(ws, "proj", "out", "a.txt"), "utf8")).toBe(
			"第一行",
		);
		expect(texts(TASK)).toContain("已写入 out/a.txt（选项 allow）");
		const written = frames.find(
			(f) =>
				f.t === "acp_event" &&
				f.kind === "tool_result" &&
				(f.payload as { path?: string }).path === "out/a.txt",
		);
		expect(written).toBeDefined();
	});

	it("拒绝：不写入", async () => {
		manager.handle({
			t: "acp_prompt",
			taskId: TASK,
			prompt: "#perm b.txt|x",
		});
		const perm = await until("第二个权限请求", () => permissions(TASK)[1]);
		manager.handle({
			t: "acp_permission_reply",
			taskId: TASK,
			requestId: perm.requestId,
			optionId: "reject",
		});
		await until("第四轮结束", () => turnEnds(TASK).length === 4);
		expect(texts(TASK)).toContain("本人拒绝，没有写入 b.txt（选项 reject）");
		expect(Bun.file(path.join(ws, "proj", "b.txt")).size).toBe(0);
	});

	it("fs 越界：读工作目录外的文件被拒绝", async () => {
		manager.handle({
			t: "acp_prompt",
			taskId: TASK,
			prompt: "#read ../../secret.txt",
		});
		await until("第五轮结束", () => turnEnds(TASK).length === 5);
		expect(texts(TASK)).toContain("读取失败");
		expect(texts(TASK)).toContain("超出工作目录");
		expect(texts(TASK)).not.toContain("top secret");
	});

	it("终端：先审批；选“本任务内始终允许”后同一任务不再问", async () => {
		manager.handle({ t: "acp_prompt", taskId: TASK, prompt: "#sh echo hi" });
		const perm = await until("终端审批", () =>
			permissions(TASK).find((p) => p.source === "terminal"),
		);
		expect(perm.toolCall).toMatchObject({
			title: "echo hi",
			kind: "execute",
		});
		expect(perm.options.map((o) => o.name)).toEqual([
			"允许",
			"本任务内始终允许",
			"拒绝",
		]);
		manager.handle({
			t: "acp_permission_reply",
			taskId: TASK,
			requestId: perm.requestId,
			optionId: "allow_task",
		});
		await until("第六轮结束", () => turnEnds(TASK).length === 6);
		expect(texts(TASK)).toContain("命令输出：hi");
		const asked = permissions(TASK).length;
		manager.handle({ t: "acp_prompt", taskId: TASK, prompt: "#sh echo again" });
		await until("第七轮结束", () => turnEnds(TASK).length === 7);
		expect(permissions(TASK).length).toBe(asked);
		expect(texts(TASK)).toContain("命令输出：again");
		expect(
			frames.some(
				(f) =>
					f.t === "acp_event" &&
					f.kind === "permission" &&
					(f.payload as { auto?: string }).auto === "本任务内已始终允许",
			),
		).toBe(true);
	});

	it("打断：这一轮以 cancelled 结束，会话仍在", async () => {
		manager.handle({ t: "acp_prompt", taskId: TASK, prompt: "#wait 5000" });
		await Bun.sleep(200);
		manager.handle({ t: "acp_interrupt", taskId: TASK });
		await until("被打断的一轮结束", () => turnEnds(TASK).length === 8);
		expect(turnEnds(TASK)[7]?.stopReason).toBe("cancelled");
		expect(manager.running()).toContain(TASK);
	});

	it("取消：终止会话；工作目录越界的任务起不来", async () => {
		manager.handle({ t: "acp_cancel", taskId: TASK });
		expect(manager.running()).not.toContain(TASK);
		manager.handle({
			t: "acp_start",
			taskId: TASK2,
			adapter: "fake",
			workspace: "../",
			prompt: "hi",
		});
		const err = await until("致命错误", () =>
			frames.find(
				(f) => f.t === "acp_event" && f.taskId === TASK2 && f.kind === "error",
			),
		);
		expect(err).toMatchObject({ payload: { fatal: true } });
		expect(JSON.stringify(err)).toContain("超出工作目录");
		await until("越界任务已移除", () => !manager.running().includes(TASK2));
	});
});
