import type { Context } from "hono";
import type { z } from "zod";
import { badRequest, formatZodError } from "@/lib/errors";

/** 读 JSON 请求体并按 schema 校验；非 JSON 或不合法 → 400。 */
export async function parseJson<S extends z.ZodType>(
	c: Context,
	schema: S,
): Promise<z.infer<S>> {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		throw badRequest("请求体不是合法 JSON");
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw badRequest(formatZodError(parsed.error));
	return parsed.data;
}
