import type { ErrorBody, ErrorCode } from "@orgos/protocol";
import { ERROR_CODES } from "@orgos/protocol";
import type { ZodError } from "zod";

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;

/** 业务错误：路由抛出，由 app.onError 统一转成 `{ error: { code, message } }`。 */
export class AppError extends Error {
	constructor(
		readonly status: ErrorStatus,
		readonly code: ErrorCode,
		message: string,
	) {
		super(message);
		this.name = "AppError";
	}
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
	return { error: { code, message } };
}

export function badRequest(message: string): AppError {
	return new AppError(400, ERROR_CODES.BAD_REQUEST, message);
}

export function notFound(message = "not found"): AppError {
	return new AppError(404, ERROR_CODES.NOT_FOUND, message);
}

export function formatZodError(error: ZodError): string {
	return error.issues
		.map((i) =>
			i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
		)
		.join("; ");
}

/** 沿 cause 链找到 postgres 驱动错误（drizzle 会把它包一层）。 */
export function pgErrorOf(
	e: unknown,
): { code: string; constraint_name?: string } | null {
	let cur: unknown = e;
	for (let depth = 0; cur && depth < 5; depth++) {
		if (
			typeof cur === "object" &&
			"code" in cur &&
			typeof (cur as { code: unknown }).code === "string" &&
			"severity" in cur
		) {
			return cur as { code: string; constraint_name?: string };
		}
		cur = (cur as { cause?: unknown }).cause;
	}
	return null;
}

export const PG_UNIQUE_VIOLATION = "23505";
