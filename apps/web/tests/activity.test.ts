import { describe, expect, it } from "vitest";
import {
	type ActivityMap,
	activityIn,
	applyDraftFrame,
	applyStatusFrame,
	clearAgentActivity,
	isWorkingIn,
} from "@/lib/activity";

const C = "c1";
const A = "a1";
const T = "t1";
const ids = { conversationId: C, agentId: A, topicId: T };
const key = `${T}:${A}`;

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
		expect(m[C]?.[key]).toEqual({
			agentId: A,
			topicId: T,
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
		expect(m[C]?.[key]).toEqual({
			agentId: A,
			topicId: T,
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
		expect(m[C]?.[key]?.runId).toBe("new");
	});

	it("没有先收到 status 的草稿也能显示；消息落库后清除", () => {
		let m = applyDraftFrame(
			{},
			{ t: "draft", ...ids, runId: "r", delta: "好" },
		);
		expect(m[C]?.[key]?.draft).toBe("好");
		m = clearAgentActivity(m, C, A, T);
		expect(m).toEqual({});
		expect(clearAgentActivity(m, C, A, T)).toBe(m);
	});

	it("同一代理在两个话题里同时工作：各算各的；话题里只列本话题的，会话列表看得到它在忙", () => {
		let m: ActivityMap = {};
		m = applyStatusFrame(m, {
			t: "status",
			...ids,
			runId: "r1",
			state: "thinking",
		});
		m = applyStatusFrame(m, {
			t: "status",
			...ids,
			topicId: "t2",
			runId: "r2",
			state: "tool",
			label: "正在处理…",
		});
		expect(activityIn(m[C], T, false).map((a) => a.runId)).toEqual(["r1"]);
		expect(activityIn(m[C], "t2", false).map((a) => a.runId)).toEqual(["r2"]);
		m = clearAgentActivity(m, C, A, T);
		expect(activityIn(m[C], T, false)).toEqual([]);
		expect(isWorkingIn(m[C], A)).toBe(true);
	});

	it("不带话题的活动（旧服务端）算在主线", () => {
		const m = applyStatusFrame(
			{},
			{
				t: "status",
				conversationId: C,
				agentId: A,
				runId: "r",
				state: "thinking",
			},
		);
		expect(activityIn(m[C], "main", true)).toHaveLength(1);
		expect(activityIn(m[C], "other", false)).toHaveLength(0);
	});
});
