/**
 * 浏览器 WS 帧（仅服务端 → 浏览器）。发送一律走 REST。
 */
import { z } from "zod";
import { PRINCIPAL_STATUSES } from "./entities";
import { EventSchema } from "./events";

export const BROWSER_PING_INTERVAL_MS = 20_000;

/** 浏览器 WS 的关闭码。 */
export const WS_CLOSE = {
	UNAUTHORIZED: 4401,
	NOT_ONBOARDED: 4404,
} as const;

export const BrowserFrameSchema = z.discriminatedUnion("t", [
	z.object({ t: z.literal("event"), event: EventSchema }),
	z.object({ t: z.literal("ping") }),
	/** 同租户某人的在线状态变了。 */
	z.object({
		t: z.literal("presence"),
		principalId: z.uuid(),
		status: z.enum(PRINCIPAL_STATUSES),
	}),
]);
export type BrowserFrame = z.infer<typeof BrowserFrameSchema>;

export type ParseResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: string };

/** 解析一帧文本；不抛异常。 */
export function parseBrowserFrame(raw: string): ParseResult<BrowserFrame> {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: "不是合法 JSON" };
	}
	const parsed = BrowserFrameSchema.safeParse(json);
	return parsed.success
		? { ok: true, data: parsed.data }
		: { ok: false, error: parsed.error.message };
}
