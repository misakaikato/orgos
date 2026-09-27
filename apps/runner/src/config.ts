/**
 * 本机配对信息 `runner.json`：{ server, runnerId, token }，权限 0600。
 * 目录默认 ~/.orgos，`ORGOS_RUNNER_HOME` 可改（测试用）。
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const RunnerConfigSchema = z.object({
	server: z.url(),
	runnerId: z.uuid(),
	token: z.string().min(1),
});
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

/** 配对目录的规则（唯一定义处；桌面端经 `@orgos/runner/config` 引用）。 */
export function runnerHomeFor(
	env: Record<string, string | undefined>,
	home: string,
): string {
	return env.ORGOS_RUNNER_HOME || path.join(home, ".orgos");
}

export function configPathFor(
	env: Record<string, string | undefined>,
	home: string,
): string {
	return path.join(runnerHomeFor(env, home), "runner.json");
}

export function runnerHome(): string {
	return runnerHomeFor(process.env, homedir());
}

export function configPath(): string {
	return configPathFor(process.env, homedir());
}

export async function saveConfig(config: RunnerConfig): Promise<string> {
	const file = configPath();
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await writeFile(file, `${JSON.stringify(config, null, "\t")}\n`, {
		mode: 0o600,
	});
	// 文件已存在时 writeFile 不改权限：显式收紧。
	await chmod(file, 0o600);
	return file;
}

export async function loadConfig(): Promise<RunnerConfig> {
	const file = configPath();
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		throw new Error(`还没有配对：找不到 ${file}，先运行 pair`);
	}
	const parsed = RunnerConfigSchema.safeParse(JSON.parse(raw));
	if (!parsed.success) throw new Error(`${file} 内容不合法，请重新配对`);
	return parsed.data;
}
