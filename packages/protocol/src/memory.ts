/**
 * 记忆层：记忆条目、画像、提炼作业、本人的类别授权，以及相关的 REST 出入参。
 *
 * 类别表只在这里定义一处：前八类默认可对外，后六类默认禁止；本人可在"对外政策"页逐类开关。
 */
import { z } from "zod";
import { EventSchema } from "./events";

export const MEMORY_CATEGORIES = [
	"项目进展",
	"排期与交付",
	"技术方案",
	"决定与口径",
	"客户与商务",
	"流程与制度",
	"工作方式偏好",
	"人员与分工",
	"私人事务",
	"薪酬",
	"健康",
	"家庭",
	"人事评价",
	"凭据与安全",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** 默认可对外的类别（前八类）；其余默认禁止。 */
export const DEFAULT_DISCLOSED_CATEGORIES: ReadonlySet<MemoryCategory> =
	new Set(MEMORY_CATEGORIES.slice(0, 8));

export function isMemoryCategory(value: unknown): value is MemoryCategory {
	return (
		typeof value === "string" &&
		(MEMORY_CATEGORIES as readonly string[]).includes(value)
	);
}

export const MEMORY_KINDS = [
	"fact",
	"decision",
	"commitment",
	"progress",
	"preference",
	"relation",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
	fact: "事实",
	decision: "决定",
	commitment: "承诺",
	progress: "进展",
	preference: "偏好",
	relation: "关系",
};

export const MEMORY_STATUSES = ["active", "superseded", "retracted"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_SCOPE_KINDS = [
	"owner",
	"participants",
	"unit",
	"tenant",
] as const;

/** 条目的可见范围：由来源自动决定。 */
export const MemoryScopeSchema = z.object({
	kind: z.enum(MEMORY_SCOPE_KINDS),
	principalIds: z.array(z.uuid()).optional(),
	unitId: z.uuid().optional(),
});
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MEMORY_SOURCE_KINDS = [
	"event",
	"task_log",
	"work_item",
	"note",
] as const;

export const MemorySourceSchema = z.object({
	kind: z.enum(MEMORY_SOURCE_KINDS),
	/** event / task_log 为数字 id，work_item / note 为 uuid，一律存成字符串。 */
	id: z.string(),
	conversationId: z.uuid().optional(),
	topicId: z.uuid().optional(),
});
export type MemorySource = z.infer<typeof MemorySourceSchema>;

export const MEMORY_ENTITY_TYPES = [
	"person",
	"project",
	"customer",
	"topic",
] as const;

export const MemoryEntitySchema = z.object({
	type: z.enum(MEMORY_ENTITY_TYPES),
	name: z.string(),
	principalId: z.uuid().optional(),
});
export type MemoryEntity = z.infer<typeof MemoryEntitySchema>;

export const MEMORY_JOB_TRIGGERS = [
	"idle",
	"compaction",
	"task_end",
	"resolution",
] as const;
export type MemoryJobTrigger = (typeof MEMORY_JOB_TRIGGERS)[number];

export const MEMORY_JOB_STATUSES = [
	"pending",
	"running",
	"done",
	"failed",
] as const;

/** 话题最后一条人类消息之后这么久没有新消息，才提炼（去抖）。 */
export const MEMORY_IDLE_DEBOUNCE_MS = 10 * 60 * 1000;

export const MemoryItemSchema = z.object({
	id: z.uuid(),
	subjectId: z.uuid(),
	kind: z.enum(MEMORY_KINDS),
	content: z.string(),
	category: z.enum(MEMORY_CATEGORIES),
	entities: z.array(MemoryEntitySchema),
	scope: MemoryScopeSchema,
	sources: z.array(MemorySourceSchema),
	confidence: z.number(),
	status: z.enum(MEMORY_STATUSES),
	supersededById: z.uuid().nullable(),
	ownerCorrected: z.boolean(),
	validFrom: z.iso.datetime(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

/** 回复里引用条目的标记：`[M:<条目 id 前 8 位>]`。 */
export const CITATION_MARK_RE = /\[M:([0-9a-f]{8})\]/g;

export function citationMark(itemId: string): string {
	return `[M:${itemId.slice(0, 8)}]`;
}

// ─────────────────────────── REST ───────────────────────────

export const MemoryItemsQuerySchema = z.object({
	q: z.string().trim().max(200).optional(),
	status: z.enum(MEMORY_STATUSES).optional(),
	/** 给了时列该单元的条目（仅负责人）。 */
	unitId: z.uuid().optional(),
});
export type MemoryItemsQuery = z.infer<typeof MemoryItemsQuerySchema>;

export const MemoryItemListResponseSchema = z.object({
	items: z.array(MemoryItemSchema),
});
export type MemoryItemListResponse = z.infer<
	typeof MemoryItemListResponseSchema
>;

export const MEMORY_CONTENT_MAX_LENGTH = 500;

export const UpdateMemoryItemRequestSchema = z.object({
	content: z.string().trim().min(1).max(MEMORY_CONTENT_MAX_LENGTH).optional(),
	category: z.enum(MEMORY_CATEGORIES).optional(),
});
export type UpdateMemoryItemRequest = z.infer<
	typeof UpdateMemoryItemRequestSchema
>;

export const MemoryItemResponseSchema = z.object({ item: MemoryItemSchema });
export type MemoryItemResponse = z.infer<typeof MemoryItemResponseSchema>;

/** 条目出处里我看得到的原消息（我是该会话成员才列出）。 */
export const MemorySourceLinkSchema = z.object({
	conversationId: z.uuid(),
	topicId: z.uuid(),
	seq: z.number().int(),
	label: z.string(),
});
export type MemorySourceLink = z.infer<typeof MemorySourceLinkSchema>;

export const MemorySourcesResponseSchema = z.object({
	links: z.array(MemorySourceLinkSchema),
});
export type MemorySourcesResponse = z.infer<typeof MemorySourcesResponseSchema>;

export const DisclosureRuleSchema = z.object({
	category: z.enum(MEMORY_CATEGORIES),
	allowed: z.boolean(),
	/** 本人没改过，取默认值。 */
	isDefault: z.boolean(),
});
export type DisclosureRule = z.infer<typeof DisclosureRuleSchema>;

export const DisclosureResponseSchema = z.object({
	rules: z.array(DisclosureRuleSchema),
});
export type DisclosureResponse = z.infer<typeof DisclosureResponseSchema>;

export const UpdateDisclosureRequestSchema = z.object({
	category: z.enum(MEMORY_CATEGORIES),
	allowed: z.boolean(),
});
export type UpdateDisclosureRequest = z.infer<
	typeof UpdateDisclosureRequestSchema
>;

/** 代答记录：分身替本人对他人的一次回答。 */
export const TwinAnswerSchema = z.object({
	answer: EventSchema,
	/** 对方的提问（引起这次回答的消息；上报恢复后的回答没有）。 */
	question: EventSchema.nullable(),
	askedById: z.uuid(),
	conversationId: z.uuid(),
	/** 被引用的条目当前的状态（本人更正或撤回后会变）。 */
	citedStatus: z.record(z.string(), z.enum(MEMORY_STATUSES)),
	/** 被引用的条目里本人的那些（本人能更正、撤回或改类别的）。 */
	ownCited: z.array(z.uuid()).optional(),
	/** 本人已对这条回答做过的处理。 */
	handled: z.enum(["corrected", "withheld"]).nullable(),
});
export type TwinAnswer = z.infer<typeof TwinAnswerSchema>;

export const TwinAnswerListResponseSchema = z.object({
	items: z.array(TwinAnswerSchema),
});
export type TwinAnswerListResponse = z.infer<
	typeof TwinAnswerListResponseSchema
>;

/** "不对"：写一条本人更正的条目并取代被引用的（本人的）条目。 */
export const CorrectAnswerRequestSchema = z.object({
	text: z.string().trim().min(1).max(MEMORY_CONTENT_MAX_LENGTH),
	category: z.enum(MEMORY_CATEGORIES).optional(),
	/** 只取代这些被引用的条目（缺省为全部被引用的本人条目）。 */
	replaces: z.array(z.uuid()).optional(),
});
export type CorrectAnswerRequest = z.infer<typeof CorrectAnswerRequestSchema>;

/** "不许对外说"：把被引用的（本人的）条目撤回，或改成一个默认禁止的类别。 */
export const WithholdAnswerRequestSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("retract") }),
	z.object({
		mode: z.literal("category"),
		category: z.enum(MEMORY_CATEGORIES),
	}),
]);
export type WithholdAnswerRequest = z.infer<typeof WithholdAnswerRequestSchema>;

export const AnswerActionResponseSchema = z.object({
	/** 受影响的条目（更正时首条为新写的更正条目）。 */
	items: z.array(MemoryItemSchema),
});
export type AnswerActionResponse = z.infer<typeof AnswerActionResponseSchema>;
