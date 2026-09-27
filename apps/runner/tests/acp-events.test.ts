import { describe, expect, it } from "bun:test";
import type { TaskLogKind } from "@orgos/protocol";
import { createAcpEventHandler, relativeInside } from "@/acp/events";
import { createTranscript } from "@/acp/history";

function setup() {
	const out: { kind: TaskLogKind; payload: unknown }[] = [];
	const emit = (kind: TaskLogKind, payload: unknown) =>
		out.push({ kind, payload });
	const transcript = createTranscript((text) => emit("agent_text", { text }), {
		idleMs: 10_000,
	});
	const translate = createAcpEventHandler({
		emit: emit as never,
		transcript,
		workspace: "/ws",
	});
	return { out, translate, transcript };
}

describe("session/update → 任务记录", () => {
	it("文字片段合成一段，在工具调用之前成段", () => {
		const { out, translate } = setup();
		translate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "我来" },
		});
		translate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "看看。" },
		});
		translate({
			sessionUpdate: "tool_call",
			toolCallId: "t1",
			title: "Read a.py",
			kind: "read",
			status: "pending",
			rawInput: { path: "/ws/a.py" },
		});
		expect(out).toEqual([
			{ kind: "agent_text", payload: { text: "我来看看。" } },
			{
				kind: "tool_call",
				payload: {
					toolCallId: "t1",
					title: "Read a.py",
					kind: "read",
					input: { path: "/ws/a.py" },
				},
			},
		]);
	});

	it("同一调用的多条 update 只记一次开头；完成时记结果（沿用开头的标题），diff 的路径转成相对路径", () => {
		const { out, translate } = setup();
		translate({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit" });
		translate({
			sessionUpdate: "tool_call_update",
			toolCallId: "t2",
			status: "in_progress",
		});
		translate({
			sessionUpdate: "tool_call_update",
			toolCallId: "t2",
			status: "completed",
			content: [{ type: "diff", path: "/ws/src/a.py", newText: "x = 1" }],
		});
		expect(out.map((o) => o.kind)).toEqual(["tool_call", "tool_result"]);
		expect(out[1]?.payload).toMatchObject({
			title: "Edit",
			ok: true,
			path: "src/a.py",
			output: "--- /ws/src/a.py\nx = 1",
		});
	});

	it("思考与用户消息回显不记；工作目录外的路径不算产出", () => {
		const { out, translate, transcript } = setup();
		translate({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "嗯" },
		});
		translate({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "原话" },
		});
		transcript.flush();
		expect(out).toEqual([]);
		expect(relativeInside("/ws", "/etc/passwd")).toBeUndefined();
		expect(relativeInside("/ws", "/ws")).toBeUndefined();
		expect(relativeInside("/ws", "b/c.txt")).toBe("b/c.txt");
	});
});
