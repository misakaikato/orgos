import { describe, expect, it } from "vitest";
import {
	type ActivityMap,
	applyDraftFrame,
	applyStatusFrame,
	clearAgentActivity,
} from "@/lib/activity";

const C = "c1";
const A = "a1";
const ids = { conversationId: C, agentId: A };

describe("代理活动状态", () => {
	it("thinking → 草稿累积 → tool 清空草稿换说明 → idle 移除", () => {
		let m: ActivityMap = {};
		m = applyStatusFrame(m, {
			t: "status",
			...ids,
			runId: "r",
			state: "thinking",
		});
		m = applyDraftFrame(m, { t: "draft", ...ids, runId: "r", delta: "收到：" });
		m = applyDraftFrame(m, { t: "draft", ...ids, runId: "r", delta: "你好" });
		expect(m[C]?.[A]).toEqual({
			runId: "r",
			state: "thinking",
			draft: "收到：你好",
		});
		m = applyStatusFrame(m, {
			t: "status",
			...ids,
			runId: "r",
			state: "tool",
			label: "正在查资料…",
		});
		expect(m[C]?.[A]).toEqual({
			runId: "r",
			state: "tool",
			label: "正在查资料…",
			draft: "",
		});
		m = applyStatusFrame(m, { t: "status", ...ids, runId: "r", state: "idle" });
		expect(m).toEqual({});
	});

	it("旧运行的 idle 不清掉新运行", () => {
		let m: ActivityMap = {};
		m = applyStatusFrame(m, {
			t: "status",
			...ids,
			runId: "new",
			state: "thinking",
		});
		m = applyStatusFrame(m, {
			t: "status",
			...ids,
			runId: "old",
			state: "idle",
		});
		expect(m[C]?.[A]?.runId).toBe("new");
	});

	it("没有先收到 status 的草稿也能显示；消息落库后清除", () => {
		let m = applyDraftFrame(
			{},
			{ t: "draft", ...ids, runId: "r", delta: "好" },
		);
		expect(m[C]?.[A]?.draft).toBe("好");
		m = clearAgentActivity(m, C, A);
		expect(m).toEqual({});
		expect(clearAgentActivity(m, C, A)).toBe(m);
	});
});
