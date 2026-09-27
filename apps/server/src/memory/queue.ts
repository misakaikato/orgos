/**
 * 提炼作业的入队（写入方与触发点在同一事务里调用）。四种触发：
 * - idle：话题里有人类消息，最后一条之后 10 分钟无新消息再提炼（去抖：同一话题只留一个待办作业，推后执行时间）；
 * - compaction：话题压缩前，被压缩的那段事件即材料（立即执行）；
 * - task_end：任务结束（立即执行）；
 * - resolution：上报被答复、协商结束——不调模型，直接写 decision 条目，出处指向该事件。
 */
import {
	MEMORY_IDLE_DEBOUNCE_MS,
	type MemoryJobTrigger,
} from "@orgos/protocol";
import { and, eq } from "drizzle-orm";
import { memoryJobs } from "@/db/schema";
import type { Scoped } from "@/db/scope";

export type MemoryJobRow = typeof memoryJobs.$inferSelect;

/** 话题有新的人类消息：推后（或新建）该话题的去抖作业。 */
export async function scheduleIdleExtraction(
	tx: Scoped,
	topicId: string,
	at: Date,
): Promise<void> {
	const runAfter = new Date(at.getTime() + MEMORY_IDLE_DEBOUNCE_MS);
	const [bumped] = await tx.executor
		.update(memoryJobs)
		.set({ runAfter })
		.where(
			tx.where(
				memoryJobs,
				and(
					eq(memoryJobs.topicId, topicId),
					eq(memoryJobs.trigger, "idle"),
					eq(memoryJobs.status, "pending"),
				),
			),
		)
		.returning({ id: memoryJobs.id });
	if (bumped) return;
	await tx.insert(memoryJobs, { topicId, trigger: "idle", runAfter });
}

/** 立即执行的作业（压缩前、任务结束、答复与协商结束）。 */
export async function enqueueMemoryJob(
	tx: Scoped,
	input: {
		topicId: string;
		trigger: Exclude<MemoryJobTrigger, "idle">;
		eventId?: number;
		runAfter?: Date;
	},
): Promise<void> {
	await tx.insert(memoryJobs, {
		topicId: input.topicId,
		trigger: input.trigger,
		eventId: input.eventId ?? null,
		runAfter: input.runAfter ?? new Date(),
	});
}
