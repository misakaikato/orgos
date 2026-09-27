/**
 * 回复里的依据：代理在用到的记忆后面写 `[M:<短编号>]`，落库时解析为 payload.citations 并从正文剥离。
 * 只认本轮 memory_search 真正给出过的条目；编造或不认识的标记直接去掉。
 */
import { CITATION_MARK_RE, type MessageCitation } from "@orgos/protocol";

/** 去掉引用标记（连同标记前的空白）；没有标记的文本原样返回。 */
export function stripCitationMarks(text: string): string {
	return text.replace(/[ \t]*\[M:[0-9a-f]{8}\]/g, "");
}

export function extractCitations(
	text: string,
	citable: ReadonlyMap<string, MessageCitation>,
): { text: string; citations: MessageCitation[] } {
	const citations: MessageCitation[] = [];
	for (const m of text.matchAll(CITATION_MARK_RE)) {
		const found = citable.get(m[0]);
		if (found && !citations.some((c) => c.id === found.id))
			citations.push(found);
	}
	return { text: stripCitationMarks(text), citations };
}
