/**
 * REST 出入参。服务端用这些 schema 校验入参，前端用同一份类型。
 */
import { z } from "zod";
import {
	AgentSchema,
	HandleSchema,
	PrincipalSchema,
	TenantSchema,
	UserSchema,
} from "./entities";

/** 统一错误体：`{ error: { code, message } }`。 */
export const ErrorBodySchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
	}),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const ERROR_CODES = {
	BAD_REQUEST: "BAD_REQUEST",
	UNAUTHORIZED: "UNAUTHORIZED",
	FORBIDDEN: "FORBIDDEN",
	NOT_FOUND: "NOT_FOUND",
	NOT_ONBOARDED: "NOT_ONBOARDED",
	ALREADY_ONBOARDED: "ALREADY_ONBOARDED",
	HANDLE_TAKEN: "HANDLE_TAKEN",
	INVITE_CODE_INVALID: "INVITE_CODE_INVALID",
	INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const DisplayNameSchema = z.string().trim().min(1).max(40);

export const OnboardingRequestSchema = z.discriminatedUnion("mode", [
	z.object({
		mode: z.literal("create"),
		orgName: z.string().trim().min(1).max(60),
		displayName: DisplayNameSchema,
		handle: HandleSchema,
	}),
	z.object({
		mode: z.literal("join"),
		inviteCode: z.string().trim().min(1).max(64),
		displayName: DisplayNameSchema,
		handle: HandleSchema,
	}),
]);
export type OnboardingRequest = z.infer<typeof OnboardingRequestSchema>;

export const OnboardingResponseSchema = z.object({
	tenant: TenantSchema,
	principal: PrincipalSchema,
	agents: z.array(AgentSchema).length(2),
});
export type OnboardingResponse = z.infer<typeof OnboardingResponseSchema>;

export const MeResponseSchema = z.object({
	user: UserSchema,
	tenant: TenantSchema,
	principal: PrincipalSchema,
	agents: z.array(AgentSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const DirectoryResponseSchema = z.object({
	people: z.array(
		z.object({
			principal: PrincipalSchema,
			front: PrincipalSchema,
		}),
	),
});
export type DirectoryResponse = z.infer<typeof DirectoryResponseSchema>;
