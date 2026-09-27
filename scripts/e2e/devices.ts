/**
 * 设备 Runner（R）、外部助手（fake 适配器）、租户隔离与设备吊销。
 * Runner 以子进程运行真实的命令行（pair、serve），ORGOS_RUNNER_HOME 与工作目录都是临时目录。
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
	AgentResponseSchema,
	CreatePairingCodeResponseSchema,
	DirectoryResponseSchema,
	type Event,
	type Run,
	RunListResponseSchema,
	RunnerListResponseSchema,
	RunResponseSchema,
	type Task,
	TaskListResponseSchema,
	TaskLogResponseSchema,
	TaskResponseSchema,
	TopicListResponseSchema,
	TopicResponseSchema,
} from "@orgos/protocol";
import { exited, runCli, wsHandshakeStatus } from "@tests/process-harness";
import {
	type Agent,
	check,
	equal,
	eventAfter,
	events,
	excludes,
	expectError,
	expectStatus,
	includes,
	type Member,
	openDm,
	openItem,
	openItems,
	post,
	replyFrom,
	resolveItem,
	type Scenario,
	waitFor,
} from "./kit";

export const device: Scenario = {
	name: "设备 Runner",
	async run(w, step) {
		const { alice, bob } = w;
		let dm = "";
		const ask = async (text: string) => {
			const asked = await post(alice.client, dm, text);
			return asked.id;
		};
		const reply = async (after: number) =>
			(await replyFrom(alice.client, dm, alice.ops, after)).payload.text;
		const approvals = async () =>
			(await openItems(alice)).filter((x) => x.kind === "approval");

		await step(
			"pair 写入 runner.json；serve 连上后在线，声明四项设备能力与 agent.acp",
			async () => {
				const { code } = CreatePairingCodeResponseSchema.parse(
					await expectStatus(
						"取配对码",
						await alice.client.request("POST", "/api/runners/pairing-codes"),
						201,
					),
				);
				const pair = runCli(w.runnerHome, [
					"pair",
					code,
					"--server",
					w.base,
					"--name",
					"e2e-Mac",
				]);
				equal("pair 退出码", await exited(pair), 0);
				const config = JSON.parse(
					await readFile(path.join(w.runnerHome, "runner.json"), "utf8"),
				) as { runnerId: string; token: string };
				w.device.runnerId = config.runnerId;
				w.device.token = config.token;
				// Runner 的环境里混进 token 与服务器地址：外部 agent 的子进程一个都不许看到。
				const child = runCli(
					w.runnerHome,
					["serve", "--workspace", w.workspace, "--adapters", "fake"],
					{
						ORGOS_DEV: "1",
						ORGOS_RUNNER_TOKEN: config.token,
						ORGOS_SERVER_URL: w.base,
					},
				);
				child.stderr?.on("data", (d: Buffer) => {
					w.device.log += d.toString();
				});
				w.device.child = child;
				const online = await waitFor(
					"设备在线且 fake 适配器可用",
					async () => {
						const res = await alice.client.request("GET", "/api/runners");
						const r = RunnerListResponseSchema.parse(
							await res.json(),
						).items.find(
							(x) => x.id === config.runnerId && x.status === "online",
						);
						const acp = r?.capabilities.find((c) => c.name === "agent.acp");
						return acp?.adapters?.some((a) => a.id === "fake" && a.available)
							? r
							: null;
					},
					30_000,
				);
				equal(
					"设备能力",
					online.capabilities.map((c) => c.name),
					["fs.list", "fs.read", "fs.write", "shell.exec", "agent.acp"],
				);
			},
		);
		await step("绑定执行助手后 #ls . 直接列出目录，不产生待办", async () => {
			await expectStatus(
				"绑定设备",
				await alice.client.request("PATCH", `/api/agents/${alice.ops.id}`, {
					runnerId: w.device.runnerId,
				}),
				200,
			);
			dm = await openDm(alice.client, alice.ops.id);
			const text = await reply(await ask("#ls ."));
			includes("目录列表", text, "readme.md");
			equal("审批待办", (await approvals()).length, 0);
		});
		await step("#exec echo hi：先审批，批准后回复含 hi", async () => {
			const after = await ask("#exec echo hi");
			const item = await openItem(
				"审批待办",
				alice,
				(x) => x.kind === "approval",
			);
			await resolveItem(alice, item.id, { action: "approve" });
			includes("回复", await reply(after), "hi");
		});
		await step("#exec echo no：拒绝后回复含“拒绝”", async () => {
			const after = await ask("#exec echo no");
			const item = await openItem(
				"审批待办",
				alice,
				(x) => x.kind === "approval",
			);
			await resolveItem(alice, item.id, { action: "deny" });
			includes("回复", await reply(after), "拒绝");
		});
		await step(
			"#read ../../etc/passwd：越出工作目录被拒，没读到内容",
			async () => {
				const text = await reply(await ask("#read ../../etc/passwd"));
				includes("回复", text, "超出工作目录");
				excludes("回复", text, "root:");
			},
		);
		await step(
			"bob 问 alice 的分身 #exec echo x：无权限，不产生审批",
			async () => {
				const asked = await post(bob.client, w.ids.pairDm, "#exec echo x", {
					askTwin: true,
				});
				const text = (
					await replyFrom(bob.client, w.ids.pairDm, alice.twin, asked.id)
				).payload.text;
				includes("回复", text, "无权限");
				equal("审批待办", (await approvals()).length, 0);
			},
		);
	},
};

async function runsIn(m: Member, topicId: string): Promise<Run[]> {
	const body = await expectStatus(
		"读运行记录",
		await m.client.request("GET", `/api/runs?topicId=${topicId}`),
		200,
	);
	return RunListResponseSchema.parse(body).items;
}

/** 等话题里出现第 n 次运行并结束（运行列表最近的在前）。 */
function nthRunDone(m: Member, topicId: string, n: number): Promise<Run> {
	return waitFor(
		`话题里第 ${n} 次运行结束`,
		async () => {
			const runs = await runsIn(m, topicId);
			return runs.length >= n && runs[0]?.state === "completed"
				? runs[0]
				: null;
		},
		20_000,
	);
}

async function taskById(m: Member, id: string): Promise<Task> {
	const body = await expectStatus(
		"读任务",
		await m.client.request("GET", `/api/tasks/${id}`),
		200,
	);
	return TaskResponseSchema.parse(body).task;
}

const taskIn = (m: Member, id: string, state: Task["state"]) =>
	waitFor(
		`任务 ${state}`,
		async () => {
			const t = await taskById(m, id);
			return t.state === state ? t : null;
		},
		20_000,
	);

export const external: Scenario = {
	name: "任务与外部助手",
	async run(w, step) {
		const { alice, bob } = w;
		let ext: Agent = { id: "", handle: "" };
		let dm = "";
		let main = "";
		let side = "";
		let firstSession = "";

		await step(
			"在已配对设备上建 fake 外部助手；主线发“列出文件”→ 外部助手回复，运行带外部会话 id",
			async () => {
				const created = AgentResponseSchema.parse(
					await expectStatus(
						"建外部助手",
						await alice.client.request("POST", "/api/agents", {
							kind: "external",
							displayName: "测试助手",
							handle: "alice-ext",
							adapter: "fake",
							runnerId: w.device.runnerId,
							workspace: "proj",
						}),
						201,
					),
				).agent;
				ext = { id: created.principal.id, handle: created.principal.handle };
				dm = await openDm(alice.client, ext.id);
				const topics = TopicListResponseSchema.parse(
					await expectStatus(
						"读话题",
						await alice.client.request(
							"GET",
							`/api/conversations/${dm}/topics`,
						),
						200,
					),
				).items;
				main = topics[0]?.id ?? "";
				const asked = await post(alice.client, dm, "列出文件");
				includes(
					"外部助手的回复",
					(
						await replyFrom(alice.client, dm, ext, asked.id, {
							timeoutMs: 30_000,
						})
					).payload.text,
					"我是测试用的假助手",
				);
				const run = await nthRunDone(alice, main, 1);
				firstSession = run.externalSessionId ?? "";
				check(
					"外部会话 id",
					firstSession.startsWith("fake-"),
					"fake-…",
					firstSession,
				);
				const logs = RunResponseSchema.parse(
					await expectStatus(
						"读运行日志",
						await alice.client.request("GET", `/api/runs/${run.id}`),
						200,
					),
				).logs;
				const text = logs
					.flatMap((l) =>
						l.kind === "agent_text"
							? [(l.payload as { text: string }).text]
							: [],
					)
					.join("");
				const keys = (
					text.split("\n").find((l) => l.startsWith("环境变量：")) ?? ""
				)
					.slice("环境变量：".length)
					.split(",");
				check("fake agent 的环境", keys.includes("PATH"), "含 PATH", keys);
				for (const secret of [
					"ORGOS_RUNNER_TOKEN",
					"ORGOS_SERVER_URL",
					"ORGOS_RUNNER_HOME",
				])
					check(
						"fake agent 的环境",
						!keys.includes(secret),
						`不含 ${secret}`,
						keys,
					);
				excludes("运行日志", JSON.stringify(logs), w.device.token);
			},
		);
		await step(
			"同一话题再发：沿用同一外部会话；另一个话题：另起一个外部会话",
			async () => {
				await post(alice.client, dm, "再说一句");
				equal(
					"主线第二轮的外部会话",
					(await nthRunDone(alice, main, 2)).externalSessionId,
					firstSession,
				);
				side = TopicResponseSchema.parse(
					await expectStatus(
						"开话题",
						await alice.client.request(
							"POST",
							`/api/conversations/${dm}/topics`,
							{ title: "写文件" },
						),
						201,
					),
				).topic.id;
				await post(alice.client, dm, "看看 calc.py", { topicId: side });
				const other =
					(await nthRunDone(alice, side, 1)).externalSessionId ?? "";
				check(
					"另一个话题的外部会话",
					other.startsWith("fake-") && other !== firstSession,
					`fake-… 且 ≠ ${firstSession}`,
					other,
				);
			},
		);
		let task: Task | undefined;
		await step(
			"话题转为任务：落 task.created，这一轮结束后 input_required",
			async () => {
				const body = await expectStatus(
					"转为任务",
					await alice.client.request("POST", `/api/topics/${side}/to-task`, {
						goal: "准备测试文件",
					}),
					201,
				);
				task = TaskResponseSchema.parse(body).task;
				await eventAfter(
					"task.created",
					alice.client,
					dm,
					0,
					(e): e is Extract<Event, { type: "task.created" }> =>
						e.type === "task.created" && e.payload.taskId === task?.id,
					{ topicId: side },
				);
				await taskIn(alice, task.id, "input_required");
			},
		);
		await step(
			"#perm 写入 a.txt：审批待办、任务 awaiting_approval；批准后文件落在工作目录、任务回到 working",
			async () => {
				const id = task?.id ?? "";
				await post(alice.client, dm, "#perm 写入 a.txt", { topicId: side });
				const item = await openItem(
					"审批待办",
					alice,
					(x) => x.kind === "approval",
				);
				equal(
					"任务状态",
					(await taskById(alice, id)).state,
					"awaiting_approval",
				);
				await resolveItem(alice, item.id, { action: "approve" });
				await waitFor("a.txt 落在工作目录", async () =>
					stat(path.join(w.workspace, "proj", "a.txt")).then(() => true),
				);
				await taskIn(alice, id, "input_required");
				const states = (await events(alice.client, dm, side)).flatMap((e) =>
					e.type === "task.updated" && e.payload.taskId === id
						? [e.payload.state]
						: [],
				);
				const at = states.lastIndexOf("awaiting_approval");
				check(
					"批准后的任务状态",
					at >= 0 && states.slice(at + 1).includes("working"),
					"awaiting_approval 之后回到 working",
					states,
				);
			},
		);
		await step(
			"“完成”→ completed；“新任务”→ 新 taskId；task_logs 按 seq 连续",
			async () => {
				const id = task?.id ?? "";
				const done = TaskResponseSchema.parse(
					await expectStatus(
						"完成任务",
						await alice.client.request("POST", `/api/tasks/${id}/complete`),
						200,
					),
				).task;
				equal("任务状态", done.state, "completed");
				const fresh = TaskResponseSchema.parse(
					await expectStatus(
						"新任务",
						await alice.client.request("POST", "/api/tasks", {
							conversationId: dm,
							goal: "再看一眼 calc.py",
						}),
						201,
					),
				).task;
				check("新任务", fresh.id !== id, "新的 taskId", fresh.id);
				await taskIn(alice, fresh.id, "input_required");
				const { items } = TaskLogResponseSchema.parse(
					await expectStatus(
						"读任务日志",
						await alice.client.request("GET", `/api/tasks/${id}/log`),
						200,
					),
				);
				equal(
					"日志 seq",
					items.map((l) => l.seq),
					items.map((_, i) => i + 1),
				);
			},
		);
		await step(
			"bob 经 alice 的分身交办给外部助手：无权限，不起任务",
			async () => {
				const asked = await post(
					bob.client,
					w.ids.pairDm,
					`#delegate:${ext.handle} 帮我看看代码`,
					{ askTwin: true },
				);
				includes(
					"分身的回复",
					(await replyFrom(bob.client, w.ids.pairDm, alice.twin, asked.id))
						.payload.text,
					"无权限",
				);
				const tasks = TaskListResponseSchema.parse(
					await expectStatus(
						"读任务",
						await alice.client.request("GET", "/api/tasks"),
						200,
					),
				).items;
				equal(
					"相关任务",
					tasks.filter((t) => t.goal.includes("帮我看看代码")).length,
					0,
				);
			},
		);
	},
};

export const isolation: Scenario = {
	name: "租户隔离",
	async run(w, step) {
		const { alice, dave } = w;
		await step(
			"dave 请求 alice 的会话、待办、代理、设备：一律 404",
			async () => {
				for (const [what, method, p, body] of [
					[
						"会话",
						"GET",
						`/api/conversations/${w.ids.pairDm}/events`,
						undefined,
					],
					[
						"待办",
						"POST",
						`/api/work-items/${w.ids.decisionItem}/resolve`,
						{ action: "answer", text: "x" },
					],
					[
						"代理",
						"PATCH",
						`/api/agents/${alice.ops.id}`,
						{ displayName: "x" },
					],
					["设备", "DELETE", `/api/runners/${w.device.runnerId}`, undefined],
				] as const)
					await expectError(
						`dave 请求 alice 的${what}`,
						await dave.client.request(method, p, body),
						404,
					);
			},
		);
		await step(
			"dave 的通讯录里没有 alice；用 alice 分身的 id 建私聊 → 404",
			async () => {
				const people = DirectoryResponseSchema.parse(
					await expectStatus(
						"dave 读通讯录",
						await dave.client.request("GET", "/api/directory"),
						200,
					),
				).people;
				excludes("dave 的通讯录", JSON.stringify(people), alice.id);
				await expectError(
					"dave 找 alice 的分身",
					await dave.client.request("POST", "/api/conversations", {
						kind: "dm",
						withPrincipalId: alice.twin.id,
					}),
					404,
				);
			},
		);
	},
};

export const revoke: Scenario = {
	name: "设备吊销",
	async run(w, step) {
		await step(
			"吊销后 Runner 的连接被关闭（4003），重连握手被拒（HTTP 401）",
			async () => {
				await expectStatus(
					"吊销设备",
					await w.alice.client.request(
						"DELETE",
						`/api/runners/${w.device.runnerId}`,
					),
					204,
				);
				await waitFor("Runner 收到 4003", async () =>
					w.device.log.includes("4003"),
				);
				equal(
					"重连握手",
					await wsHandshakeStatus(
						w.base,
						`/runner/ws?token=${encodeURIComponent(w.device.token)}`,
					),
					401,
				);
			},
		);
	},
};
