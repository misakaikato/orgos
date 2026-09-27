/**
 * 话题的纯函数（不依赖 React，便于单测）：话题栏的排序、事件按话题归属、未读、任务状态点。
 */
import {
	type Event,
	type Task,
	type Topic,
	type TopicTaskPhase,
	topicTaskPhase,
} from "@orgos/protocol";

/** 话题栏的顺序：主线置顶，其余按最近活动倒序；归档的不列。 */
export function visibleTopics(list: readonly Topic[]): Topic[] {
	const main = list.filter((t) => t.isMain);
	const rest = list
		.filter((t) => !t.isMain && !t.archivedAt)
		.sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
	return [...main, ...rest];
}

/** 新建或变化的话题并入列表（按 id 替换，没有则追加）。 */
export function upsertTopic(list: readonly Topic[], topic: Topic): Topic[] {
	const at = list.findIndex((t) => t.id === topic.id);
	if (at < 0) return [...list, topic];
	const copy = [...list];
	copy[at] = topic;
	return copy;
}

/** 任务状态变了：指向它的话题跟着换状态点。 */
export function withTaskState(list: Topic[], task: Task): Topic[] {
	if (!list.some((t) => t.taskId === task.id && t.taskState !== task.state))
		return list;
	return list.map((t) =>
		t.taskId === task.id ? { ...t, taskState: task.state } : t,
	);
}

/** 事件属于这个话题吗（不带话题的旧事件算主线）。 */
export function inTopic(event: Event, topic: Pick<Topic, "id" | "isMain">) {
	return event.topicId ? event.topicId === topic.id : topic.isMain;
}

export function eventsOfTopic(
	events: readonly Event[] | undefined,
	topic: Pick<Topic, "id" | "isMain">,
): Event[] {
	return (events ?? []).filter((e) => inTopic(e, topic));
}

/** 已加载的事件里某话题的最大 seq（补读的起点）。 */
export function maxSeqIn(events: readonly Event[], topicId: string): number {
	let max = 0;
	for (const e of events)
		if (e.topicId === topicId && (e.seq ?? 0) > max) max = e.seq ?? 0;
	return max;
}

/**
 * 话题有没有我没看过的他人消息：已加载的事件里，在 `seen`（我在这个话题看到的位置，没有则取打开会话时的
 * 已读位置）之后有他人消息；或者这个话题我在本次还没看过、而列表带来的未读数大于 0。
 */
export function topicHasUnread(
	events: readonly Event[] | undefined,
	topic: Pick<Topic, "id" | "isMain" | "unread">,
	seen: number,
	meId: string,
	viewed: boolean,
): boolean {
	if (!viewed && (topic.unread ?? 0) > 0) return true;
	return (events ?? []).some(
		(e) =>
			inTopic(e, topic) &&
			(e.seq ?? 0) > seen &&
			e.type === "message.posted" &&
			e.actorId !== meId,
	);
}

/** 任务话题的状态点：进行中 / 等你处理 / 已完成；不是任务话题为 null。 */
export function phaseOf(topic: Topic): TopicTaskPhase | null {
	return topic.kind === "task" && topic.taskState
		? topicTaskPhase(topic.taskState)
		: null;
}

export const PHASE_LABEL: Record<TopicTaskPhase, string> = {
	active: "进行中",
	attention: "等你处理",
	done: "已完成",
};
