/**
 * 实体的线上形态（REST 出参、WS 帧共用）。枚举值数组同时是数据库列的取值来源。
 */
import { z } from "zod";

export const MEMBER_ROLES = ["owner", "member"] as const;
export const PRINCIPAL_KINDS = ["human", "agent"] as const;
export const AGENT_ROLES = ["front", "specialist"] as const;
export const CONVERSATION_KINDS = ["dm", "group", "negotiation"] as const;
export const CONVERSATION_MEMBER_ROLES = ["member", "observer"] as const;
export const WORK_ITEM_KINDS = [
	"question",
	"commitment",
	"decision",
	"approval",
	"confirmation",
] as const;
export const WORK_ITEM_STATUSES = ["open", "done", "cancelled"] as const;
export const NOTE_VISIBILITIES = ["private", "shared"] as const;
export const RUNNER_STATUSES = ["online", "offline"] as const;

export const DEFAULT_AGENT_MODEL = "deepseek-v4-flash";

/** 人的 handle：小写字母开头，2–31 位小写字母、数字、连字符。 */
export const HANDLE_RE = /^[a-z][a-z0-9-]{1,30}$/;

export const HandleSchema = z.string().regex(HANDLE_RE);

export const TenantSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	/** 仅 owner 可见。 */
	inviteCode: z.string().optional(),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const PrincipalSchema = z.object({
	id: z.uuid(),
	tenantId: z.uuid(),
	kind: z.enum(PRINCIPAL_KINDS),
	userId: z.string().nullable(),
	ownerId: z.uuid().nullable(),
	handle: z.string(),
	displayName: z.string(),
	createdAt: z.iso.datetime(),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const AgentSchema = z.object({
	principal: PrincipalSchema,
	role: z.enum(AGENT_ROLES),
	description: z.string(),
	delegationPolicy: z.string(),
	model: z.string(),
	runnerId: z.uuid().nullable(),
	updatedAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const UserSchema = z.object({
	id: z.string(),
	email: z.string(),
	name: z.string(),
});
export type User = z.infer<typeof UserSchema>;
