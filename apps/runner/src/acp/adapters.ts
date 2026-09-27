/**
 * 本机能用哪些外部助手适配器：由实际探测决定。
 *
 * 适配器表只在 `@orgos/protocol` 的 `ACP_ADAPTERS` 定义一处；这里只做三件事：
 *   1. 选出本机该考虑的（测试适配器只在 `ORGOS_DEV=1` 时）；
 *   2. 探测：`requires` 里的可执行文件都在 PATH 上，且真的起得来并回应 ACP `initialize`
 *      （npx 首次拉包可能要一会儿，故探测在后台进行，完成后更新能力声明）；
 *   3. 起任务时给出启动配置，并再过一次 `enforceAcpConfig`（第二道卫生判据）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ACP_ADAPTERS,
	ACP_AGENT_METHODS,
	ACP_PROTOCOL_VERSION,
	type AcpAdapterDef,
	type AcpAdapterStatus,
	type AcpConfig,
	enforceAcpConfig,
} from "@orgos/protocol";
import { CLIENT_INFO, ORGOS_CLIENT_CAPABILITIES } from "@/acp/client";
import { createJsonRpcPeer } from "@/acp/jsonrpc";
import { buildLaunchPlan, startAcpProcess } from "@/acp/spawn";
import { log } from "@/log";

/** apps/runner 目录（测试适配器的 fixture 相对它）。 */
export const RUNNER_ROOT = path.resolve(
	fileURLToPath(new URL("../../", import.meta.url)),
);

/** 探测一个适配器的最长时间（npx 首次需要下载）。 */
export const PROBE_TIMEOUT_MS = 180_000;

export function isDevRunner(env = process.env): boolean {
	return env.ORGOS_DEV === "1";
}

/**
 * 本机提供的适配器：测试适配器只在开发模式下；`only` 给定时只提供其中列出的
 * （设备主人用 `serve --adapters` 决定这台机器上允许跑哪些外部助手，`none` 为一个都不提供）。
 */
export function candidateAdapters(
	only?: string,
	dev = isDevRunner(),
): AcpAdapterDef[] {
	const all = ACP_ADAPTERS.filter((a) => dev || !a.devOnly);
	if (only === undefined) return all;
	const ids = only === "none" ? [] : only.split(",").map((s) => s.trim());
	const unknown = ids.filter((id) => !all.some((a) => a.id === id));
	if (unknown.length > 0)
		throw new Error(
			`不认识的适配器：${unknown.join("、")}（可选：${all.map((a) => a.id).join("、")}）`,
		);
	return all.filter((a) => ids.includes(a.id));
}

/** 适配器的启动配置：fixture 用 Runner 自身的 bun 运行仓库内的文件。 */
export function launchConfigOf(def: AcpAdapterDef): AcpConfig {
	if (!def.fixture) return def.config;
	return {
		command: process.execPath,
		args: [path.join(RUNNER_ROOT, def.fixture), ...def.config.args],
		env: def.config.env,
	};
}

export function commandText(config: AcpConfig): string {
	return [config.command, ...config.args].join(" ");
}

/** 起来、握手、收掉：能回应 `initialize` 才算可用。 */
export async function probeAdapter(
	def: AcpAdapterDef,
	cwd: string,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
	if (def.requires.some((bin) => !Bun.which(bin))) return false;
	const { config, rejection } = enforceAcpConfig(launchConfigOf(def));
	if (rejection) return false;
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			proc.kill();
			resolve(ok);
		};
		const peer = createJsonRpcPeer({
			write: (frame) => proc.write(frame),
			handle: async () => ({}),
		});
		const proc = startAcpProcess({
			plan: buildLaunchPlan(config, cwd, process.env),
			onStdout: (chunk) => peer.feed(chunk),
			onStderr: () => {},
			onExit: () => finish(false),
		});
		const timer = setTimeout(() => finish(false), timeoutMs);
		peer
			.request(ACP_AGENT_METHODS.initialize, {
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: ORGOS_CLIENT_CAPABILITIES,
				clientInfo: CLIENT_INFO,
			})
			.then(
				() => finish(true),
				() => finish(false),
			);
	});
}

export type LaunchResult =
	| { ok: true; config: AcpConfig }
	| { ok: false; error: string };

/** 本机的适配器：探测结果与启动配置。 */
export class AdapterRegistry {
	private readonly available = new Map<string, boolean>();

	constructor(private readonly defs: readonly AcpAdapterDef[]) {}

	/** hello / capabilities 里上报的状态（探测完成前一律不可用）。 */
	statuses(): AcpAdapterStatus[] {
		return this.defs.map((def) => ({
			id: def.id,
			command: commandText(launchConfigOf(def)),
			available: this.available.get(def.id) ?? false,
		}));
	}

	/** 并行探测全部适配器；每个完成时回调一次。 */
	async probeAll(cwd: string, onChange: () => void): Promise<void> {
		await Promise.all(
			this.defs.map(async (def) => {
				const ok = await probeAdapter(def, cwd).catch(() => false);
				this.available.set(def.id, ok);
				log.info("acp.adapter_probed", { id: def.id, available: ok });
				onChange();
			}),
		);
	}

	launch(id: string): LaunchResult {
		const def = this.defs.find((d) => d.id === id);
		if (!def) return { ok: false, error: `这台设备不提供适配器 ${id}` };
		if (!this.available.get(id))
			return { ok: false, error: `这台设备上的 ${def.label} 当前不可用` };
		const { config, rejection } = enforceAcpConfig(launchConfigOf(def));
		if (rejection)
			return {
				ok: false,
				error: `${def.label} 的启动配置不合法（${rejection.reason}）`,
			};
		return { ok: true, config };
	}
}
