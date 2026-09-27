/**
 * orgos 设备 Runner 命令行（bun 运行）。
 *
 *   pair <配对码> --server <地址> --name <设备名>   凭配对码登记本机，写 ~/.orgos/runner.json
 *   serve --workspace <目录>                        连上服务端，在工作目录里执行代理的请求
 *
 * Runner 只执行服务端下发的四项能力，不调用任何模型、不持有任何模型密钥。
 */
import { arch, hostname, platform } from "node:os";
import {
	deviceCapabilityList,
	ErrorBodySchema,
	PairRunnerResponseSchema,
	RUNNER_PROTOCOL_VERSION,
} from "@orgos/protocol";
import { loadConfig, saveConfig } from "@/config";
import { log } from "@/log";
import { openWorkspace, runCapability } from "@/workspace";
import { startWsBridge } from "@/ws-bridge";

const RUNNER_VERSION = "0.1.0";

const USAGE = `用法：
  bun run --cwd apps/runner start pair <配对码> --server <服务端地址> --name <设备名>
  bun run --cwd apps/runner start serve --workspace <工作目录>

配对信息写在 $ORGOS_RUNNER_HOME/runner.json（默认 ~/.orgos/runner.json）。`;

function osLabel(): string {
	const name =
		{ darwin: "macOS", linux: "Linux", win32: "Windows" }[
			platform() as string
		] ?? platform();
	return `${name} ${arch()}`;
}

/** `--key value` 形式的选项与其余位置参数。 */
function parseArgs(argv: string[]): {
	positional: string[];
	flags: Map<string, string>;
} {
	const positional: string[] = [];
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg.startsWith("--")) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--"))
				throw new Error(`${arg} 缺少取值`);
			flags.set(arg.slice(2), value);
			i += 1;
		} else positional.push(arg);
	}
	return { positional, flags };
}

async function pair(code: string, server: string, name: string): Promise<void> {
	const base = new URL(server);
	const res = await fetch(new URL("/api/runners/pair", base), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, name, os: osLabel() }),
	});
	const body: unknown = await res.json().catch(() => null);
	if (res.status !== 201) {
		const err = ErrorBodySchema.safeParse(body);
		throw new Error(
			err.success ? err.data.error.message : `配对失败（HTTP ${res.status}）`,
		);
	}
	const { runnerId, token } = PairRunnerResponseSchema.parse(body);
	const file = await saveConfig({ server: base.origin, runnerId, token });
	log.info("paired", { runnerId, name, config: file });
	process.stdout.write(`已配对“${name}”，配对信息写入 ${file}\n`);
}

async function serve(workspaceArg: string): Promise<void> {
	const config = await loadConfig();
	const workspace = await openWorkspace(workspaceArg);
	log.info("serve", { runnerId: config.runnerId, workspace });
	const bridge = startWsBridge(config.server, config.token, {
		hello: () => ({
			t: "hello",
			protocol: RUNNER_PROTOCOL_VERSION,
			runnerVersion: RUNNER_VERSION,
			os: osLabel(),
			hostname: hostname(),
			workspace,
			capabilities: deviceCapabilityList(),
		}),
		onDown: (msg) => {
			// 每个 job 独立执行，互不等待；结果按 jobId 交回。
			log.info("job.start", { jobId: msg.jobId, capability: msg.capability });
			void runCapability(workspace, msg.capability, msg.args).then((r) => {
				log.info("job.done", { jobId: msg.jobId, ok: r.ok });
				bridge.send({ t: "result", jobId: msg.jobId, ...r });
			});
		},
	});
	const stop = () => {
		bridge.close();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

async function main(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	const { positional, flags } = parseArgs(rest);
	if (command === "pair") {
		const [code] = positional;
		const server = flags.get("server");
		const name = flags.get("name");
		if (!code || !server || !name) throw new Error(USAGE);
		await pair(code, server, name);
		return;
	}
	if (command === "serve") {
		const workspace = flags.get("workspace");
		if (!workspace) throw new Error(USAGE);
		await serve(workspace);
		return;
	}
	throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((e) => {
	process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
