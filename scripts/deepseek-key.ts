/**
 * DeepSeek key 的来源（dev.ts 与 smoke-llm.ts 共用）：环境里的 DEEPSEEK_API_KEY 优先；
 * 否则从 ~/.pi/agent/auth.json 只取 `deepseek.key` 这一个字段——该文件里还有别的令牌，
 * 不打印、不写文件、不碰其他字段。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type DeepseekKey = { key: string; source: "env" | "pi" };

async function deepseekKeyFromPi(): Promise<string | null> {
	const file = Bun.file(join(homedir(), ".pi", "agent", "auth.json"));
	if (!(await file.exists())) return null;
	try {
		const parsed: unknown = JSON.parse(await file.text());
		const deepseek =
			parsed && typeof parsed === "object"
				? (parsed as Record<string, unknown>).deepseek
				: undefined;
		const key =
			deepseek && typeof deepseek === "object"
				? (deepseek as Record<string, unknown>).key
				: undefined;
		return typeof key === "string" && key.trim() ? key.trim() : null;
	} catch {
		return null;
	}
}

export async function resolveDeepseekKey(): Promise<DeepseekKey | null> {
	if (process.env.DEEPSEEK_API_KEY)
		return { key: process.env.DEEPSEEK_API_KEY, source: "env" };
	const key = await deepseekKeyFromPi();
	return key ? { key, source: "pi" } : null;
}
