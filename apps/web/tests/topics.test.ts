import type { Event, Principal, Task, Topic } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import { describeEvent } from "@/lib/describe";
import { buildThreadRows } from "@/lib/thread";
import {
	eventsOfTopic,
	maxSeqIn,
	phaseOf,
	topicHasUnread,
	upsertTopic,
	visibleTopics,
	withTaskState,
} from "@/lib/topics";

const TENANT = "44444444-4444-4444-8444-444444444444";
const CONV = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const EXT = "55555555-5555-4555-8555-555555555555";
const MAIN = "77777777-7777-4777-8777-777777777771";
const SIDE = "77777777-7777-4777-8777-777777777772";
const T1 = "66666666-6666-4666-8666-666666666661";
const AT = "2026-09-27T08:00:00.000Z";

const ext: Principal = {
	id: EXT,
	tenantId: TENANT,
	kind: "agent",
	userId: null,
	ownerId: ME,
	handle: "me-claude",
	displayName: "Claude Code",
	createdAt: AT,
};
const map = new Map([[EXT, ext]]);

let seq = 0;
function base(topicId: string, actorId = EXT) {
	seq += 1;
	return {
		id: seq,
		tenantId: TENANT,
		conversationId: CONV,
		topicId,
		seq,
		actorId,
		onBehalfOfId: actorId === EXT ? ME : null,
		createdAt: AT,
	};
}
function message(topicId: string, text: string, actorId = EXT): Event {
	return {
		...base(topicId, actorId),
		type: "message.posted",
		payload: { text, mentions: [] },
	};
}

function topic(over: Partial<Topic>): Topic {
	return {
		id: SIDE,
		tenantId: TENANT,
		conversationId: CONV,
		title: "话题",
		kind: "chat",
		taskId: null,
		isMain: false,
		createdBy: ME,
		archivedAt: null,
		createdAt: AT,
		lastEventAt: AT,
		...over,
	};
}

describe("话题里的消息列", () => {
	it("接了任务与任务结束是系统行；状态变化不进消息列；没有任务卡片", () => {
		const events: Event[] = [
			{
				...base(SIDE),
				type: "task.created",
				payload: { taskId: T1, title: "加一个函数" },
			},
			{
				...base(SIDE),
				type: "task.updated",
				payload: { taskId: T1, state: "input_required" },
			},
			message(SIDE, "做好了"),
			{
				...base(SIDE),
				type: "task.ended",
				payload: {
					taskId: T1,
					state: "completed",
					summary: "做完了",
					artifacts: [],
				},
			},
		];
		const kinds = buildThreadRows(events, map, ME, null).map((r) => r.kind);
		expect(kinds.filter((k) => k !== "stamp")).toEqual([
			"system",
			"bubble",
			"system",
		]);
		expect(describeEvent(events[0] as Event, map, ME)).toBe(
			"Claude Code接了任务：加一个函数",
		);
		expect(describeEvent(events[3] as Event, map, ME)).toBe(
			"任务已完成：做完了",
		);
	});

	it("转成群聊与退群的说法", () => {
		const moved: Event = {
			...base(SIDE, ME),
			type: "topic.moved",
			payload: { conversationId: CONV, title: "方案讨论" },
		};
		expect(describeEvent(moved, map, ME)).toBe(
			"你把这个话题转成了群聊“方案讨论”",
		);
		const left: Event = {
			...base(MAIN, ME),
			type: "member.left",
			payload: { principalId: ME },
		};
		expect(describeEvent(left, map, ME)).toBe("你退出了群聊");
	});
});

describe("话题栏", () => {
	const main = topic({
		id: MAIN,
		isMain: true,
		title: "主线",
		lastEventAt: AT,
	});
	const older = topic({
		id: "a",
		title: "旧",
		lastEventAt: "2026-09-27T07:00:00.000Z",
	});
	const newer = topic({
		id: "b",
		title: "新",
		lastEventAt: "2026-09-27T09:00:00.000Z",
	});
	const archived = topic({ id: "c", archivedAt: AT });

	it("主线置顶，其余按最近活动；归档的不列；按 id 并入", () => {
		expect(
			visibleTopics([older, archived, newer, main]).map((t) => t.id),
		).toEqual([MAIN, "b", "a"]);
		const renamed = upsertTopic([main, older], { ...older, title: "改名" });
		expect(renamed.map((t) => t.title)).toEqual(["主线", "改名"]);
		expect(upsertTopic([main], older).map((t) => t.id)).toEqual([MAIN, "a"]);
	});

	it("事件按话题归属（不带话题的旧事件算主线）；未读只看他人消息", () => {
		const a = message(SIDE, "旁支");
		const b = message(MAIN, "主线");
		const legacy: Event = { ...message(MAIN, "旧"), topicId: undefined };
		const mine = message(SIDE, "我说的", ME);
		const all = [a, b, legacy, mine];
		const side = topic({ id: SIDE });
		expect(eventsOfTopic(all, side).map((e) => e.seq)).toEqual([
			a.seq,
			mine.seq,
		]);
		expect(eventsOfTopic(all, main).map((e) => e.seq)).toEqual([
			b.seq,
			legacy.seq,
		]);
		expect(maxSeqIn(all, SIDE)).toBe(mine.seq);
		expect(topicHasUnread(all, side, 0, ME, false)).toBe(true);
		expect(topicHasUnread(all, side, a.seq ?? 0, ME, true)).toBe(false);
		// 事件没加载的话题：本次还没看过时以列表带来的未读数为准。
		expect(topicHasUnread([], { ...side, unread: 2 }, 0, ME, false)).toBe(true);
		expect(topicHasUnread([], { ...side, unread: 2 }, 0, ME, true)).toBe(false);
	});

	it("任务话题的状态点随任务变化：进行中 / 等你处理 / 已完成", () => {
		const t = topic({ kind: "task", taskId: T1, taskState: "working" });
		expect(phaseOf(t)).toBe("active");
		const task = { id: T1, state: "input_required" } as Task;
		const [after] = withTaskState([t], task);
		expect(after?.taskState).toBe("input_required");
		expect(phaseOf(after as Topic)).toBe("attention");
		expect(phaseOf({ ...t, taskState: "completed" })).toBe("done");
		expect(phaseOf(topic({}))).toBeNull();
		const same = [t];
		expect(withTaskState(same, { id: T1, state: "working" } as Task)).toBe(
			same,
		);
	});
});
