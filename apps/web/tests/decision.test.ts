import { describe, expect, it } from "vitest";
import { answerRequest, choiceAfterEdit } from "@/lib/decision";

const OPTIONS = ["可以，按 85 折签", "不行，最多 9 折"];

describe("决策表单的候选", () => {
	it("选中候选且未改动：带 option", () => {
		expect(answerRequest(OPTIONS[1] ?? "", OPTIONS, 1, false)).toEqual({
			action: "answer",
			text: OPTIONS[1],
			option: 1,
		});
	});

	it("选了候选又改过：转为自己写，不带 option", () => {
		const edited = `${OPTIONS[0]}，下周签`;
		expect(choiceAfterEdit(0, OPTIONS, edited)).toBe("custom");
		expect(choiceAfterEdit(0, OPTIONS, OPTIONS[0] ?? "")).toBe(0);
		expect(answerRequest(edited, OPTIONS, 0, true)).toEqual({
			action: "answer",
			text: edited,
			saveAsNote: true,
		});
	});

	it("自己写或没有候选：不带 option；空答复不能提交", () => {
		expect(answerRequest(" 再说 ", OPTIONS, "custom", false)).toEqual({
			action: "answer",
			text: "再说",
		});
		expect(answerRequest("可以", [], null, false)).toEqual({
			action: "answer",
			text: "可以",
		});
		expect(answerRequest("  ", OPTIONS, "custom", false)).toBeNull();
	});
});
