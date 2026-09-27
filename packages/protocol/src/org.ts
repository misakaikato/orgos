/**
 * 组织结构：单元（部门）是一种主体（principals.kind='unit'），有负责人、成员、章程，
 * 以及随单元建立的分身（`<单元名>的分身`）与单元群。本期单元只有"负责人"一种决策人。
 */
import { z } from "zod";
import {
	HandleSchema,
	NoteSchema,
	PrincipalSchema,
	UNIT_NOTE_VISIBILITIES,
} from "./entities";

export const UNIT_MEMBER_ROLES = ["head", "member"] as const;
export type UnitMemberRole = (typeof UNIT_MEMBER_ROLES)[number];

export const UNIT_MEMBER_ROLE_LABEL: Record<UnitMemberRole, string> = {
	head: "负责人",
	member: "成员",
};

export const UNIT_NAME_MAX_LENGTH = 40;
export const CHARTER_MAX_LENGTH = 4000;

export const UnitMemberSchema = z.object({
	principal: PrincipalSchema,
	role: z.enum(UNIT_MEMBER_ROLES),
	isPrimary: z.boolean(),
});
export type UnitMember = z.infer<typeof UnitMemberSchema>;

/** `GET /api/org` 里的一个单元。 */
export const OrgUnitSchema = z.object({
	unit: PrincipalSchema,
	head: PrincipalSchema,
	members: z.array(UnitMemberSchema),
	twin: PrincipalSchema,
	parentId: z.uuid().nullable(),
	/** 章程：负责人写给单元分身的自然语言政策。 */
	charter: z.string().optional(),
	/** 单元群。 */
	groupId: z.uuid().nullable().optional(),
});
export type OrgUnit = z.infer<typeof OrgUnitSchema>;

export const OrgResponseSchema = z.object({
	units: z.array(OrgUnitSchema),
});
export type OrgResponse = z.infer<typeof OrgResponseSchema>;

const UnitNameSchema = z.string().trim().min(1).max(UNIT_NAME_MAX_LENGTH);

export const CreateUnitRequestSchema = z.object({
	name: UnitNameSchema,
	handle: HandleSchema,
	parentId: z.uuid().optional(),
	headId: z.uuid(),
});
export type CreateUnitRequest = z.infer<typeof CreateUnitRequestSchema>;

export const UpdateUnitRequestSchema = z.object({
	name: UnitNameSchema.optional(),
	headId: z.uuid().optional(),
	charter: z.string().trim().max(CHARTER_MAX_LENGTH).optional(),
	/** null：移到顶层。 */
	parentId: z.uuid().nullable().optional(),
});
export type UpdateUnitRequest = z.infer<typeof UpdateUnitRequestSchema>;

export const AddUnitMemberRequestSchema = z.object({
	principalId: z.uuid(),
	role: z.enum(UNIT_MEMBER_ROLES).optional(),
	isPrimary: z.boolean().optional(),
});
export type AddUnitMemberRequest = z.infer<typeof AddUnitMemberRequestSchema>;

export const OrgUnitResponseSchema = z.object({ unit: OrgUnitSchema });
export type OrgUnitResponse = z.infer<typeof OrgUnitResponseSchema>;

/** 单元页：我在这个单元里的身份，以及我看得到的单元资料与单元分身最近的决定。 */
export const UnitDetailResponseSchema = z.object({
	unit: OrgUnitSchema,
	/** 我的身份：负责人、成员，或都不是（null）。 */
	myRole: z.enum(UNIT_MEMBER_ROLES).nullable(),
	/** 我能管理单元树（租户 owner）。 */
	canAdminister: z.boolean(),
	notes: z.array(NoteSchema),
	/** 单元分身用 record_decision 记下的决定（我看得到的），最近的在前。 */
	decisions: z.array(NoteSchema),
});
export type UnitDetailResponse = z.infer<typeof UnitDetailResponseSchema>;

const NoteTitleSchema = z.string().trim().min(1).max(120);
const NoteBodySchema = z.string().max(8000);

export const CreateUnitNoteRequestSchema = z.object({
	title: NoteTitleSchema,
	body: NoteBodySchema,
	visibility: z.enum(UNIT_NOTE_VISIBILITIES).default("unit"),
});
export type CreateUnitNoteRequest = z.input<typeof CreateUnitNoteRequestSchema>;

export const UpdateUnitNoteRequestSchema = z.object({
	title: NoteTitleSchema.optional(),
	body: NoteBodySchema.optional(),
	visibility: z.enum(UNIT_NOTE_VISIBILITIES).optional(),
});
export type UpdateUnitNoteRequest = z.infer<typeof UpdateUnitNoteRequestSchema>;

/** 记忆与代答记录接口的可选参数：给了 unitId 时操作该单元（仅负责人）。 */
export const MemoryUnitQuerySchema = z.object({
	unitId: z.uuid().optional(),
});
export type MemoryUnitQuery = z.infer<typeof MemoryUnitQuerySchema>;

/** 单元的称呼：`问产品部` 按钮等处用。 */
export function askUnitLabel(unitName: string): string {
	return `问${unitName}`;
}
