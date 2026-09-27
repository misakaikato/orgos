/**
 * 集成（MOCK_LLM=1）：R 执行助手在本人的设备上干活——列目录与读文件直接下发；写文件与执行命令
 * 先建审批待办，批准后执行、拒绝 / 超时 / 被新消息打断则不执行；设备离线立即失败；
 * 为他人办事时设备工具不可用（编造调用得到"无权限"且不建待办）。设备以假连接接入并自动应答。
 */
import {
	CreatePairingCodeResponseSchema,
	type Event,
	PairRunnerResponseSchema,
	type WorkItem,
	WorkItemListResponseSchema,
	WorkItemResponseSchema,
} from "@orgos/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scheduler } from "@/agent/scheduler";
import { runners, workItems } from "@/db/schema";
import { scoped } from "@/db/scope";
import { requestApproval } from "@/services/work-items";
import {
	actions,
	eventsOf,
	messagesBy,
	openDm,
	openGroup,
	say,
} from "./agent-helpers";
import { anonymous, type Client, createTeam, type TeamMember } from "./helpers";
import { connectRunner, type FakeRunner, HELLO } from "./runner-helpers";

let alice: TeamMember;
let bob: TeamMember;
let ops: string;
let twin: string;
let runnerId: string;
let device: FakeRunner;
let dm: string;

function respond(invoke: { capability: string; args: unknown }) {
	const args = invoke.args as { path?: string; command?: string };
	switch (invoke.capability) {
		case "fs.list":
			return { ok: true, output: "a.txt  7 B\nb.txt  3 B" };
		case "fs.read":
			return args.path?.startsWith("..")
				? { ok: false, output: "路径超出工作目录，已拒绝" }
				: { ok: true, output: "文件内容" };
		case "fs.write":
			return { ok: true, output: `已写入 ${args.path}` };
		default:
			return {
				ok: true,
				output: `${(args.command ?? "").replace(/^echo /, "")}\n`,
				exitCode: 0,
			};
	}
}

beforeAll(async () => {
	[alice, bob] = (await createTeam(["Alice", "Bob"])) as [
		TeamMember,
		TeamMember,
	];
	ops =
		alice.me.agents.find((a) => a.role === "specialist")?.principal.id ?? "";
	twin = alice.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
	const codeRes = await alice.client.request(
		"POST",
		"/api/runners/pairing-codes",
	);
	const { code } = CreatePairingCodeResponseSchema.parse(await codeRes.json());
	const paired = await anonymous.request("POST", "/api/runners/pair", {
		code,
		name: "Alice 的 Mac",
		os: "macOS arm64",
	});
	runnerId = PairRunnerResponseSchema.parse(await paired.json()).runnerId;
	const row = await scoped(alice.me.tenant.id).first(
		runners,
		eq(runners.id, runnerId),
	);
	if (!row) throw new Error("设备不存在");
	device = connectRunner(row, respond);
	await device.up(HELLO);
	const bound = await alice.client.request("PATCH", `/api/agents/${ops}`, {
		runnerId,
	});
	expect(bound.status).toBe(200);
	dm = await openDm(alice.client, ops);
});

afterAll(async () => {
	await device.close();
});

async function openItems(c: Client): Promise<WorkItem[]> {
	const res = await c.request("GET", "/api/work-items?status=open");
	return WorkItemListResponseSchema.parse(await res.json()).items;
}

async function approvals(c: Client): Promise<WorkItem[]> {
	return (await openItems(c)).filter((w) => w.kind === "approval");
}

/** 发消息但不等运行结束（运行会停在等本人审批上）。 */
async function post(c: Client, conversationId: string, text: string) {
	const res = await c.request(
		"POST",
		`/api/conversations/${conversationId}/messages`,
		{ text },
	);
	expect(res.status).toBe(201);
}

async function waitForApproval(c: Client): Promise<WorkItem> {
	for (let i = 0; i < 250; i++) {
		const [item] = await approvals(c);
		if (item) return item;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("没有等到审批待办");
}

function resolve(c: Client, id: string, action: string) {
	return c.request("POST", `/api/work-items/${id}/resolve`, { action });
}

function lastReply(events: Event[], agentId: string): string {
	return messagesBy(events, agentId).at(-1)?.payload.text ?? "";
}

function invokedCommands(): string[] {
	return device.down.flatMap((f) =>
		f.t === "invoke" && f.capability === "shell.exec"
			? [(f.args as { command: string }).command]
			: [],
	);
}

describe("为本人：读类直接下发", () => {
	it("#ls . → 得到目录列表，不产生待办", async () => {
		await say(alice.client, dm, "#ls .");
		const events = await eventsOf(alice.client, dm);
		expect(lastReply(events, ops)).toBe("完成：a.txt  7 B\nb.txt  3 B");
		expect(actions(events).at(-1)?.payload).toMatchObject({
			tool: "device_list",
			ok: true,
		});
		expect(await approvals(alice.client)).toEqual([]);
	});

	it("#read ../../etc/passwd → 回复含错误提示，没有读到内容", async () => {
		await say(alice.client, dm, "#read ../../etc/passwd");
		const reply = lastReply(await eventsOf(alice.client, dm), ops);
		expect(reply).toContain("超出工作目录");
		expect(reply).not.toContain("root:");
	});
});

describe("为本人：写与执行先审批", () => {
	it("#exec echo hi → 审批待办与卡片；批准后执行并回显", async () => {
		await post(alice.client, dm, "#exec echo hi");
		const item = await waitForApproval(alice.client);
		expect(item).toMatchObject({
			kind: "approval",
			ownerId: alice.me.principal.id,
			requesterId: ops,
			conversationId: dm,
			payload: {
				runnerId,
				capability: "shell.exec",
				args: { command: "echo hi" },
			},
		});
		expect(item.title).toContain("Alice 的 Mac");
		expect(invokedCommands()).not.toContain("echo hi");

		const res = await resolve(alice.client, item.id, "approve");
		expect(res.status).toBe(200);
		expect(
			WorkItemResponseSchema.parse(await res.json()).workItem,
		).toMatchObject({
			status: "done",
			resolution: { outcome: "approve" },
		});
		await scheduler.idle(dm);
		const events = await eventsOf(alice.client, dm);
		expect(lastReply(events, ops)).toContain("hi");
		expect(invokedCommands()).toContain("echo hi");
		const requested = events.find((e) => e.type === "approval.requested");
		expect(requested).toMatchObject({
			actorId: ops,
			onBehalfOfId: alice.me.principal.id,
			payload: {
				workItemId: item.id,
				runnerName: "Alice 的 Mac",
				capability: "shell.exec",
				args: { command: "echo hi" },
			},
		});
		expect(
			events.find(
				(e) =>
					e.type === "approval.resolved" && e.payload.workItemId === item.id,
			),
		).toMatchObject({
			actorId: alice.me.principal.id,
			payload: { outcome: "approve" },
		});
		expect((await resolve(alice.client, item.id, "deny")).status).toBe(409);
	});

	it("#exec echo no 并拒绝 → 回复含“拒绝”，命令没有下发", async () => {
		await post(alice.client, dm, "#exec echo no");
		const item = await waitForApproval(alice.client);
		expect((await resolve(alice.client, item.id, "deny")).status).toBe(200);
		await scheduler.idle(dm);
		expect(lastReply(await eventsOf(alice.client, dm), ops)).toContain("拒绝");
		expect(invokedCommands()).not.toContain("echo no");
	});

	it("#write 路径|内容 → 批准后写入", async () => {
		await post(alice.client, dm, "#write notes/x.txt|你好");
		const item = await waitForApproval(alice.client);
		expect(item.payload).toMatchObject({
			capability: "fs.write",
			args: { path: "notes/x.txt", content: "你好" },
		});
		await resolve(alice.client, item.id, "approve");
		await scheduler.idle(dm);
		expect(lastReply(await eventsOf(alice.client, dm), ops)).toContain(
			"已写入 notes/x.txt",
		);
	});

	it("同时批准与拒绝同一条审批：只有一个生效，另一个 409", async () => {
		await post(alice.client, dm, "#exec echo race");
		const item = await waitForApproval(alice.client);
		const results = await Promise.all([
			resolve(alice.client, item.id, "approve"),
			resolve(alice.client, item.id, "deny"),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		await scheduler.idle(dm);
		const resolved = (await eventsOf(alice.client, dm)).filter(
			(e) => e.type === "approval.resolved" && e.payload.workItemId === item.id,
		);
		expect(resolved).toHaveLength(1);
	});

	it("审批等待中本人发了新消息 → 审批取消、命令不执行，新一轮照常回应", async () => {
		await post(alice.client, dm, "#exec echo slow");
		const item = await waitForApproval(alice.client);
		await say(alice.client, dm, "算了");
		const row = await scoped(alice.me.tenant.id).first(
			workItems,
			eq(workItems.id, item.id),
		);
		expect(row).toMatchObject({
			status: "cancelled",
			resolution: { outcome: "cancelled" },
		});
		const events = await eventsOf(alice.client, dm);
		expect(lastReply(events, ops)).toBe("收到：算了");
		expect(invokedCommands()).not.toContain("echo slow");
		expect((await resolve(alice.client, item.id, "approve")).status).toBe(409);
	});

	it("10 分钟无人处理 → 过期（此处以短超时验证），待办作废并落 approval.resolved", async () => {
		const outcome = await requestApproval(scoped(alice.me.tenant.id), {
			agentId: ops,
			conversationId: dm,
			runnerId,
			runnerName: "Alice 的 Mac",
			capability: "shell.exec",
			args: { command: "echo late" },
			title: "测试过期",
			body: "echo late",
			signal: new AbortController().signal,
			timeoutMs: 50,
		});
		expect(outcome).toBe("expired");
		const events = await eventsOf(alice.client, dm);
		const requested = events.findLast((e) => e.type === "approval.requested");
		const workItemId =
			requested?.type === "approval.requested"
				? requested.payload.workItemId
				: "";
		expect(
			events.find(
				(e) =>
					e.type === "approval.resolved" && e.payload.workItemId === workItemId,
			),
		).toMatchObject({ actorId: ops, payload: { outcome: "expired" } });
		expect((await resolve(alice.client, workItemId, "approve")).status).toBe(
			409,
		);
	});
});

describe("不可用的情形", () => {
	it("为他人：别人问分身 #exec → 无权限，不建待办", async () => {
		const pair = await openDm(bob.client, alice.me.principal.id);
		await say(bob.client, pair, "#exec echo x", { askTwin: true });
		expect(lastReply(await eventsOf(bob.client, pair), twin)).toContain(
			"无权限",
		);
		expect(await approvals(alice.client)).toEqual([]);
	});

	it("为他人：别人在群里点名我的执行助手 #exec → 无权限，不建待办", async () => {
		const group = await openGroup(alice.client, "设备群", [
			bob.me.principal.id,
			ops,
		]);
		await say(bob.client, group, "@x #exec echo x", { mentions: [ops] });
		expect(lastReply(await eventsOf(bob.client, group), ops)).toContain(
			"无权限",
		);
		expect(await approvals(alice.client)).toEqual([]);
		expect(invokedCommands()).not.toContain("echo x");
	});

	it("没绑设备的代理（分身）为本人 #ls → 无权限", async () => {
		const own = await openDm(alice.client, twin);
		await say(alice.client, own, "#ls .");
		expect(lastReply(await eventsOf(alice.client, own), twin)).toContain(
			"无权限",
		);
	});

	it("设备离线：#ls 与 #exec 立即返回“设备离线”，不建待办", async () => {
		await device.close();
		try {
			await say(alice.client, dm, "#ls .");
			expect(lastReply(await eventsOf(alice.client, dm), ops)).toContain(
				"设备离线",
			);
			await say(alice.client, dm, "#exec echo offline");
			expect(lastReply(await eventsOf(alice.client, dm), ops)).toContain(
				"设备离线",
			);
			expect(await approvals(alice.client)).toEqual([]);
		} finally {
			await device.up(HELLO);
		}
	});
});
