import type { ResolveWorkItemRequest } from "@orgos/protocol";

/** 决策表单里选中的是第几个候选，或"自己写"；都没选为 null。 */
export type DecisionChoice = number | "custom" | null;

/**
 * 答复框改动后的选择：选中的候选被改过即转为"自己写"。
 */
export function choiceAfterEdit(
	choice: DecisionChoice,
	options: readonly string[],
	text: string,
): DecisionChoice {
	return typeof choice === "number" && text !== options[choice]
		? "custom"
		: choice;
}

/**
 * 答复的请求体：答复框的文字与所选候选一字不差时带上 option，否则按自己写的处理。
 * 答复为空 → null（不能提交）。
 */
export function answerRequest(
	text: string,
	options: readonly string[],
	choice: DecisionChoice,
	saveAsNote: boolean,
): Extract<ResolveWorkItemRequest, { action: "answer" }> | null {
	const answer = text.trim();
	if (!answer) return null;
	const option =
		typeof choice === "number" && options[choice] === answer
			? choice
			: undefined;
	return {
		action: "answer",
		text: answer,
		...(option === undefined ? {} : { option }),
		...(saveAsNote ? { saveAsNote } : {}),
	};
}
