/**
 * 提炼作业的执行器：进程内定时拉取到期作业，同一租户串行执行，失败按次数退避重试，
 * 用尽次数记为 failed 并留下错误；每轮作业之后重建该重建的画像。
 *
 * 进程启动时，上一个进程留下的 running 作业退回 pending（它们已没有执行者）。
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { getLlmClient } from "@/agent/llm";
import type { LlmClient } from "@/agent/llm-types";
import { memoryJobs } from "@/db/schema";
import { type Scoped, scoped, tenantsWithMemoryJobs } from "@/db/scope";
import {
	extractTopic,
	type JobOutcome,
	writeResolution,
} from "@/memory/extract";
import { rebuildDueProfiles } from "@/memory/profiles";
import type { MemoryJobRow } from "@/memory/queue";

export const MEMORY_JOB_MAX_ATTEMPTS = 3;
export const MEMORY_RETRY_BASE_MS = 30_000;
export const MEMORY_WORKER_INTERVAL_MS = 15_000;

export type DrainOptions = {
	now?: Date;
	llm?: LlmClient;
};

/** 取一个到期的 pending 作业并置为 running（并发的执行器不会取到同一个）。 */
async function claim(s: Scoped, now: Date): Promise<MemoryJobRow | null> {
	const due = s.executor
		.select({ id: memoryJobs.id })
		.from(memoryJobs)
		.where(
			s.where(
				memoryJobs,
				eq(memoryJobs.status, "pending"),
				lte(memoryJobs.runAfter, now),
			),
		)
		.orderBy(asc(memoryJobs.runAfter))
		.limit(1)
		.for("update", { skipLocked: true });
	const [row] = await s.executor
		.update(memoryJobs)
		.set({ status: "running", attempts: sql`${memoryJobs.attempts} + 1` })
		.where(s.where(memoryJobs, eq(memoryJobs.id, sql`(${due})`)))
		.returning();
	return row ?? null;
}

async function settle(
	s: Scoped,
	job: MemoryJobRow,
	patch: Partial<typeof memoryJobs.$inferInsert>,
): Promise<void> {
	await s.executor
		.update(memoryJobs)
		.set(patch)
		.where(s.where(memoryJobs, eq(memoryJobs.id, job.id)));
}

async function execute(
	s: Scoped,
	job: MemoryJobRow,
	llm: LlmClient,
	now: Date,
): Promise<JobOutcome> {
	return job.trigger === "resolution"
		? writeResolution(s, job)
		: extractTopic(s, job, llm, now);
}

/** 执行一个租户所有到期的作业，再重建该重建的画像；返回执行的作业数。 */
export async function drainMemoryJobs(
	s: Scoped,
	opts: DrainOptions = {},
): Promise<number> {
	const now = opts.now ?? new Date();
	const llm = opts.llm ?? getLlmClient();
	let n = 0;
	for (;;) {
		const job = await claim(s, now);
		if (!job) break;
		n += 1;
		try {
			const out = await execute(s, job, llm, now);
			await settle(s, job, {
				status: "done",
				error: null,
				throughEventId: out.throughEventId,
			});
			if (out.more)
				await s.insert(memoryJobs, {
					topicId: job.topicId,
					trigger: job.trigger,
					runAfter: now,
				});
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			console.error(`[memory] 作业 ${job.id}（${job.trigger}）失败`, e);
			await settle(
				s,
				job,
				job.attempts >= MEMORY_JOB_MAX_ATTEMPTS
					? { status: "failed", error }
					: {
							status: "pending",
							error,
							runAfter: new Date(
								now.getTime() + MEMORY_RETRY_BASE_MS * job.attempts,
							),
						},
			);
		}
	}
	try {
		await rebuildDueProfiles(s, llm, now);
	} catch (e) {
		console.error("[memory] 画像整理失败", e);
	}
	return n;
}

/** 进程启动：上一个进程留下的 running 作业退回 pending。 */
export async function requeueInterruptedMemoryJobs(): Promise<void> {
	for (const tenantId of await tenantsWithMemoryJobs(new Date(), {
		running: true,
	})) {
		const s = scoped(tenantId);
		await s.executor
			.update(memoryJobs)
			.set({ status: "pending" })
			.where(s.where(memoryJobs, and(eq(memoryJobs.status, "running"))));
	}
}

let busy = false;

/** 一轮：各租户依次执行到期作业（同一租户串行）。上一轮没结束时跳过。 */
export async function memoryTick(opts: DrainOptions = {}): Promise<void> {
	if (busy) return;
	busy = true;
	try {
		for (const tenantId of await tenantsWithMemoryJobs(opts.now ?? new Date()))
			await drainMemoryJobs(scoped(tenantId), opts);
	} finally {
		busy = false;
	}
}

/** 启动定时拉取（只在服务进程入口调用一次）。 */
export function startMemoryWorker(
	intervalMs = MEMORY_WORKER_INTERVAL_MS,
): () => void {
	const timer = setInterval(() => {
		memoryTick().catch((e) => console.error("[memory] 执行器出错", e));
	}, intervalMs);
	return () => clearInterval(timer);
}
