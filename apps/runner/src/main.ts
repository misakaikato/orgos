/**
 * orgos 设备 Runner 命令行（bun 运行）。
 *
 *   pair <配对码> --server <地址> --name <设备名> [--via desktop|cli]
 *                                                   凭配对码登记本机，写 ~/.orgos/runner.json
 *   serve --workspace <目录> [--adapters …]         连上服务端，在工作目录里执行代理的请求
 *
 * Runner 执行服务端下发的四项设备能力，并以 ACP 驱动本机的外部助手（Claude Code、Codex 等）；
 * 它自己不调用任何模型、不持有任何厂商密钥。企业模式下外部助手经服务端的网关调用模型，
 * 只在任务期间持有服务端签发的任务令牌；个人模式下用本人在这台设备上的登录。
 */
import { arch, hostname, platform } from "node:os";
import {
	type AcpUp,
	AGENT_ACP_CAPABILITY,
	type Capability,
	deviceCapabilityList,
	ErrorBodySchema,
	PairRunnerResponseSchema,
	RUNNER_PROTOCOL_VERSION,
	RUNNER_VIAS,
	RUNNER_WS_CLOSE,
	type RunnerVia,
} from "@orgos/protocol";
import { AdapterRegistry, candidateAdapters } from "@/acp/adapters";
import { AcpManager } from "@/acp/session";
import { loadConfig, pairedServer, saveConfig } from "@/config";
import { log } from "@/log";
import { openWorkspace, runCapability } from "@/workspace";
import { startWsBridge } from "@/ws-bridge";

const RUNNER_VERSION = "0.1.0";

const USAGE = `用法：
  bun run --cwd apps/runner start pair <配对码> --server <服务端地址> --name <设备名> [--via desktop|cli]
  bun run --cwd apps/runner start serve --workspace <工作目录> [--adapters claude-code,codex|none]

配对信息写在 $ORGOS_RUNNER_HOME/runner.json（默认 ~/.orgos/runner.json）。
--via 标明由谁发起配对：桌面客户端传 desktop，直接在命令行运行默认为 cli。`;

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

const SERVE_HINT =
	"启动：bun run --cwd apps/runner start serve --workspace <工作目录>，或在桌面客户端里启动";

/** 配对失败时，本机若已配对，在同一行报错后说明无需重复配对（桌面客户端只显示最后一行）。 */
async function withPairedHint(message: string): Promise<string> {
	const server = await pairedServer();
	if (!server) return message;
	return `${message.replace(/[。.]$/, "")}。这台电脑已配对（服务器 ${server}），无需重复配对；配对码只能用一次。`;
}

function parseVia(value: string | undefined): RunnerVia {
	if (value === undefined) return "cli";
	const via = RUNNER_VIAS.find((v) => v === value);
	if (!via) throw new Error(`--via 只能是 ${RUNNER_VIAS.join(" 或 ")}`);
	return via;
}

async function requestPairing(
	base: URL,
	code: string,
	name: string,
	via: RunnerVia,
): Promise<{ runnerId: string; token: string }> {
	const res = await fetch(new URL("/api/runners/pair", base), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, name, os: osLabel(), via }),
	});
	const body: unknown = await res.json().catch(() => null);
	if (res.status !== 201) {
		const err = ErrorBodySchema.safeParse(body);
		throw new Error(
			err.success ? err.data.error.message : `配对失败（HTTP ${res.status}）`,
		);
	}
	return PairRunnerResponseSchema.parse(body);
}

async function pair(
	code: string,
	server: string,
	name: string,
	via: RunnerVia,
): Promise<void> {
	const base = new URL(server);
	let paired: { runnerId: string; token: string };
	try {
		paired = await requestPairing(base, code, name, via);
	} catch (e) {
		throw new Error(
			await withPairedHint(e instanceof Error ? e.message : String(e)),
		);
	}
	const { runnerId, token } = paired;
	const file = await saveConfig({ server: base.origin, runnerId, token });
	log.info("paired", { runnerId, name, via, config: file });
	process.stdout.write(
		`已配对“${name}”，配对信息写入 ${file}\n${SERVE_HINT}\n`,
	);
}

/** 断线期间外部任务的上行最多暂存多少帧（重连后补发）。 */
const OUTBOX_MAX = 1000;

async function serve(workspaceArg: string, only?: string): Promise<void> {
	const config = await loadConfig();
	const workspace = await openWorkspace(workspaceArg);
	const adapters = new AdapterRegistry(candidateAdapters(only));
	log.info("serve", {
		runnerId: config.runnerId,
		workspace,
		adapters: adapters.statuses().map((a) => a.id),
	});

	const capabilities = (): Capability[] => [
		...deviceCapabilityList(),
		{
			name: AGENT_ACP_CAPABILITY,
			description: "以 ACP 驱动本机的外部助手（Claude Code、Codex 等）",
			risk: "exec",
			adapters: adapters.statuses(),
		},
	];

	// 外部任务的上行：断线时暂存，重连并发过 hello 后按序补发（一轮结束等关键帧不能丢）。
	const outbox: AcpUp[] = [];
	const sendAcp = (frame: AcpUp) => {
		if (bridge.isOpen()) bridge.send(frame);
		else if (outbox.length < OUTBOX_MAX) outbox.push(frame);
		else log.warn("acp.outbox_full", { t: frame.t });
	};
	// 在办的事：设备操作数与外部助手会话数，变化时记一条 load（桌面端据此显示与退出前提醒）。
	let jobs = 0;
	const reportLoad = () =>
		log.info("load", { jobs, sessions: acp.running().length });
	const acp = new AcpManager({
		runnerWorkspace: workspace,
		server: config.server,
		adapters,
		send: sendAcp,
		onSessionsChanged: reportLoad,
	});

	const bridge = startWsBridge(config.server, config.token, {
		hello: () => ({
			t: "hello",
			protocol: RUNNER_PROTOCOL_VERSION,
			runnerVersion: RUNNER_VERSION,
			os: osLabel(),
			hostname: hostname(),
			workspace,
			capabilities: capabilities(),
			acpTasks: acp.running(),
		}),
		onOpen: () => {
			for (const frame of outbox.splice(0)) bridge.send(frame);
		},
		onDown: (msg) => {
			if (msg.t !== "invoke") {
				acp.handle(msg);
				return;
			}
			// 每个 job 独立执行，互不等待；结果按 jobId 交回。
			log.info("job.start", { jobId: msg.jobId, capability: msg.capability });
			jobs += 1;
			reportLoad();
			void runCapability(workspace, msg.capability, msg.args).then((r) => {
				log.info("job.done", { jobId: msg.jobId, ok: r.ok });
				jobs -= 1;
				reportLoad();
				bridge.send({ t: "result", jobId: msg.jobId, ...r });
			});
		},
		onServerClose: (code) => {
			// 设备被吊销：本机的外部助手一并终止。
			if (code === RUNNER_WS_CLOSE.REVOKED) acp.disposeAll();
		},
	});
	void adapters.probeAll(workspace, () => {
		if (bridge.isOpen())
			bridge.send({ t: "capabilities", capabilities: capabilities() });
	});
	const stop = () => {
		acp.disposeAll();
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
		await pair(code, server, name, parseVia(flags.get("via")));
		return;
	}
	if (command === "serve") {
		const workspace = flags.get("workspace");
		if (!workspace) throw new Error(USAGE);
		await serve(workspace, flags.get("adapters"));
		return;
	}
	throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((e) => {
	process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
