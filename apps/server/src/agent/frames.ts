/**
 * 代理运行中推给会话成员的 draft / status 帧（不落库）。
 */
import type { AgentRunState } from "@orgos/protocol";
import { browserHub } from "@/realtime/browser-hub";

export interface RunFrames {
	draft(delta: string): void;
	status(state: AgentRunState, label?: string): void;
}

export const silentFrames: RunFrames = {
	draft: () => {},
	status: () => {},
};

export function framesFor(
	recipients: readonly string[],
	ids: {
		conversationId: string;
		topicId: string;
		agentId: string;
		runId: string;
	},
): RunFrames {
	return {
		draft(delta) {
			if (delta) browserHub.sendTo(recipients, { t: "draft", ...ids, delta });
		},
		status(state, label) {
			browserHub.sendTo(recipients, {
				t: "status",
				...ids,
				state,
				...(label ? { label } : {}),
			});
		},
	};
}
