/**
 * 测试用的最小 ACP agent（stdio 上的 NDJSON + JSON-RPC 2.0），供 `fake` 适配器与测试使用。
 *
 * - initialize / session/new / session/prompt / session/cancel；
 * - 每个进程的第一轮先说一行"环境变量：<自身环境变量的键名，逗号分隔>"，供断言子进程看不到的键；
 * - 每轮回显："收到：<原文>。我是测试用的假助手。"；
 * - 指令（写在消息里）：
 *     `#perm <文件>|<内容>`（或 `#perm 写入 <文件>`）先 session/request_permission，允许后经 fs/write_text_file 写入；
 *     `#read <路径>` 经 fs/read_text_file 读；
 *     `#sh <命令>` 经 terminal/create 执行并取输出；
 *     `#wait <毫秒>` 等一会儿（可被 session/cancel 打断）；
 *     `#llm <话>` 用企业模式注入的 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL 调一次网关（非流式），
 *     回显模型的回复或网关的 HTTP 状态（没有注入时说明没有）。
 */
import path from "node:path";

type Msg = {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
};

const pending = new Map<
	number,
	{ resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let nextId = 1;
let cwd = process.cwd();
let sessionId = "";
let firstTurn = true;
let cancelled = false;
let toolSeq = 0;

function write(msg: Msg): void {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function request(method: string, params: unknown): Promise<unknown> {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		write({ jsonrpc: "2.0", id, method, params: params as Msg["params"] });
	});
}

function update(update: Record<string, unknown>): void {
	write({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId, update },
	});
}

function say(text: string): void {
	update({
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text },
	});
}

function parsePerm(rest: string): { file: string; content: string } {
	const at = rest.indexOf("|");
	if (at >= 0)
		return { file: rest.slice(0, at).trim(), content: rest.slice(at + 1) };
	const words = rest.trim().split(/\s+/);
	return { file: words.at(-1) ?? "a.txt", content: "来自测试助手\n" };
}

async function perm(rest: string): Promise<string> {
	const { file, content } = parsePerm(rest);
	toolSeq += 1;
	const toolCallId = `perm-${toolSeq}`;
	const target = path.resolve(cwd, file);
	update({
		sessionUpdate: "tool_call",
		toolCallId,
		title: `写入 ${file}`,
		kind: "edit",
		status: "pending",
		rawInput: { path: target, content },
	});
	const res = (await request("session/request_permission", {
		sessionId,
		toolCall: {
			toolCallId,
			title: `写入 ${file}`,
			kind: "edit",
			rawInput: { path: target, content },
		},
		options: [
			{ optionId: "allow", name: "允许", kind: "allow_once" },
			{ optionId: "allow_always", name: "始终允许", kind: "allow_always" },
			{ optionId: "reject", name: "拒绝", kind: "reject_once" },
		],
	})) as { outcome?: { outcome?: string; optionId?: string } };
	const chosen = res.outcome?.optionId;
	if (res.outcome?.outcome !== "selected" || !chosen?.startsWith("allow")) {
		update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
		return `本人拒绝，没有写入 ${file}（选项 ${chosen ?? "取消"}）`;
	}
	await request("fs/write_text_file", { sessionId, path: target, content });
	update({
		sessionUpdate: "tool_call_update",
		toolCallId,
		status: "completed",
		content: [{ type: "diff", path: target, oldText: null, newText: content }],
	});
	return `已写入 ${file}（选项 ${chosen}）`;
}

async function read(p: string): Promise<string> {
	try {
		const res = (await request("fs/read_text_file", {
			sessionId,
			path: path.resolve(cwd, p.trim()),
		})) as { content?: string };
		return `读到：${res.content ?? ""}`;
	} catch (e) {
		return `读取失败：${e instanceof Error ? e.message : String(e)}`;
	}
}

async function sh(command: string): Promise<string> {
	try {
		const { terminalId } = (await request("terminal/create", {
			sessionId,
			command: command.trim(),
		})) as { terminalId: string };
		await request("terminal/wait_for_exit", { sessionId, terminalId });
		const out = (await request("terminal/output", {
			sessionId,
			terminalId,
		})) as { output?: string };
		await request("terminal/release", { sessionId, terminalId });
		return `命令输出：${out.output ?? ""}`;
	} catch (e) {
		return `命令没有执行：${e instanceof Error ? e.message : String(e)}`;
	}
}

async function llm(text: string): Promise<string> {
	const base = process.env.OPENAI_BASE_URL;
	const key = process.env.OPENAI_API_KEY;
	if (!base || !key) return "没有注入网关";
	try {
		const res = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${key}`,
			},
			body: JSON.stringify({
				model: process.env.OPENAI_MODEL,
				messages: [{ role: "user", content: text.trim() }],
			}),
		});
		if (!res.ok) return `网关返回 HTTP ${res.status}`;
		const body = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		return `模型说：${body.choices?.[0]?.message?.content ?? ""}`;
	} catch (e) {
		return `连不上网关：${e instanceof Error ? e.message : String(e)}`;
	}
}

async function wait(ms: number): Promise<string> {
	const until = Date.now() + ms;
	while (Date.now() < until && !cancelled) await Bun.sleep(20);
	return cancelled ? "等待被打断" : `等了 ${ms} 毫秒`;
}

async function prompt(params: Record<string, unknown>): Promise<unknown> {
	cancelled = false;
	const blocks = (params.prompt ?? []) as { type?: string; text?: string }[];
	const text = blocks.map((b) => b.text ?? "").join("");
	const announceEnv = firstTurn;
	if (firstTurn) firstTurn = false;
	// 只报与隔离有关的键名，不报全量：CI 上有上百个环境变量，那一行会长到把同一轮的回复挤出摘要的截断窗口。
	if (announceEnv) {
		const keys = Object.keys(process.env)
			.filter(
				(k) =>
					k === "PATH" || k.startsWith("ORGOS_") || k.startsWith("OPENAI_"),
			)
			.sort();
		say(`环境变量：${keys.join(",")}\n`);
	}
	const m = /#(perm|read|sh|wait|llm)\s+([\s\S]*)$/.exec(text);
	let result = "";
	if (m?.[1] === "perm") result = await perm(m[2] ?? "");
	else if (m?.[1] === "read") result = await read(m[2] ?? "");
	else if (m?.[1] === "sh") result = await sh(m[2] ?? "");
	else if (m?.[1] === "wait") result = await wait(Number(m[2]) || 0);
	else if (m?.[1] === "llm") result = await llm(m[2] ?? "");
	say(`收到：${text}。`);
	say("我是测试用的假助手。");
	if (result) say(`\n${result}`);
	return { stopReason: cancelled ? "cancelled" : "end_turn" };
}

async function handle(msg: Msg): Promise<unknown> {
	switch (msg.method) {
		case "initialize":
			return {
				protocolVersion: 1,
				agentCapabilities: { loadSession: false },
				agentInfo: { name: "fake-acp", title: "测试助手", version: "1" },
				authMethods: [],
			};
		case "session/new":
			cwd = String(msg.params?.cwd ?? cwd);
			sessionId = `fake-${Math.random().toString(36).slice(2, 10)}`;
			return { sessionId };
		case "session/prompt":
			return prompt(msg.params ?? {});
		default:
			throw new Error(`method not found: ${msg.method}`);
	}
}

function onLine(line: string): void {
	if (!line.trim()) return;
	const msg = JSON.parse(line) as Msg;
	if (msg.method === undefined) {
		const waiter = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
		if (!waiter) return;
		pending.delete(msg.id as number);
		if (msg.error) waiter.reject(new Error(msg.error.message));
		else waiter.resolve(msg.result);
		return;
	}
	if (msg.method === "session/cancel") {
		cancelled = true;
		return;
	}
	const id = msg.id;
	if (id === undefined) return;
	handle(msg).then(
		(result) => write({ jsonrpc: "2.0", id, result }),
		(e: Error) =>
			write({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: e.message },
			}),
	);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) onLine(line);
});
process.stdin.on("end", () => process.exit(0));
