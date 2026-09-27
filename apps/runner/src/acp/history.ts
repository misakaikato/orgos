/**
 * 任务的过程记录在 Runner 侧的最后一站：把 agent 流式吐出的文字片段合成成段，再作为
 * `agent_text` 记录上报（服务端原样进 task_logs，那里才是任务历史的唯一存放处）。
 *
 * 不逐片上报：一次回答常有上百个片段，逐片落库既撑爆 task_logs，也让"查看过程"读不成句。
 * 成段的时机：工具调用等非文字记录到来之前、一轮结束时、片段停顿超过 `idleMs`、
 * 或一段文字攒得太长 / 太久（进行中也能看到最新进度）。
 */
export interface TaskTranscript {
	/** 收到一个文字片段。 */
	text(chunk: string): void;
	/** 把已攒的文字作为一段上报（没有则什么也不做）。 */
	flush(): void;
	dispose(): void;
}

export interface TranscriptOptions {
	/** 片段停顿多久算一段结束。 */
	idleMs?: number;
	/** 一段最长攒多久。 */
	maxAgeMs?: number;
	/** 一段最多多少字。 */
	maxChars?: number;
}

export function createTranscript(
	emit: (text: string) => void,
	opts: TranscriptOptions = {},
): TaskTranscript {
	const idleMs = opts.idleMs ?? 1_200;
	const maxAgeMs = opts.maxAgeMs ?? 5_000;
	const maxChars = opts.maxChars ?? 4_000;
	let buffer = "";
	let startedAt = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const clear = () => {
		if (timer) clearTimeout(timer);
		timer = null;
	};

	const flush = () => {
		clear();
		const text = buffer;
		buffer = "";
		if (text.trim()) emit(text);
	};

	return {
		text(chunk) {
			if (!chunk) return;
			if (!buffer) startedAt = Date.now();
			buffer += chunk;
			if (buffer.length >= maxChars || Date.now() - startedAt >= maxAgeMs) {
				flush();
				return;
			}
			clear();
			timer = setTimeout(flush, idleMs);
		},
		flush,
		dispose: clear,
	};
}
