/**
 * 一轮代理运行（由一条人类消息引起，直到结束或被打断）共享的状态与上限。
 *
 * - interrupt：新的人类消息到来，当前一步（模型调用或工具）完成后停止；等本人审批的工具随即取消；
 * - abort：POST /stop，立即中止（取消进行中的模型调用）；
 * - 交接（群聊里由代理发言引起的运行、delegate_to_teammate）累计到上限即停止。
 */
export const MAX_MODEL_CALLS = 8;
export const MAX_ROUNDS = 4;
export const MAX_HANDOFFS = 8;
export const MAX_DELEGATE_DEPTH = 2;
export const HISTORY_LIMIT = 40;

export const LIMIT_SUMMARY = {
	modelCalls: `单次运行的模型调用达到上限（${MAX_MODEL_CALLS} 次），已停止`,
	rounds: `群聊轮次达到上限（${MAX_ROUNDS} 轮），代理们先停下，等人发话`,
	handoffs: `代理之间的交接累计达到上限（${MAX_HANDOFFS} 次），已停止`,
} as const;

export type LimitKind = keyof typeof LIMIT_SUMMARY;

export class RunSession {
	private readonly controller = new AbortController();
	private readonly stopController = new AbortController();
	private interrupted = false;
	private handoffs = 0;
	/** 因交接上限停止时记下，由调度器落一条系统动作。 */
	limitHit: LimitKind | null = null;

	/** 立即中止（POST /stop）时触发。 */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** 被打断或中止时触发：等本人审批这类长等待据此取消，不拖住新一轮。 */
	get stopSignal(): AbortSignal {
		return this.stopController.signal;
	}

	/** 新的人类消息到来：在步边界停止。 */
	interrupt(): void {
		this.interrupted = true;
		this.stopController.abort();
	}

	/** 立即中止。 */
	abort(): void {
		this.controller.abort();
		this.stopController.abort();
	}

	get stopped(): boolean {
		return this.interrupted || this.signal.aborted || this.limitHit !== null;
	}

	/** 占用一次交接；已达上限则记下并返回 false。 */
	takeHandoff(): boolean {
		if (this.handoffs >= MAX_HANDOFFS) {
			this.limitHit = "handoffs";
			return false;
		}
		this.handoffs += 1;
		return true;
	}
}
