/**
 * 子进程环境的安全面：runner token、服务器地址与配置目录不可见（两道都上）；orgos 不注入任何
 * 模型密钥；命令不经 shell；适配器表里的每一条都过得了启动前的卫生判据。
 */
import { describe, expect, it } from "bun:test";
import {
	ACP_ADAPTERS,
	type AcpConfig,
	ENV_BIN,
	enforceAcpConfig,
	SCRUBBED_ENV_KEYS,
} from "@orgos/protocol";
import { launchConfigOf } from "@/acp/adapters";
import { buildLaunchPlan, scrubEnv } from "@/acp/spawn";

const SECRET = "ort_super-secret-token";

const RUNNER_ENV: Record<string, string> = {
	ORGOS_RUNNER_TOKEN: SECRET,
	ORGOS_SERVER_URL: "http://localhost:8930",
	ORGOS_RUNNER_HOME: "/Users/x/.orgos",
	PATH: "/usr/local/bin:/usr/bin",
	HOME: "/Users/x",
};

const CONFIG: AcpConfig = {
	command: "npx",
	args: ["-y", "@zed-industries/claude-code-acp@0.16.2"],
	env: {},
};

describe("env 清洗", () => {
	it("被清洗的键都不在子进程的 env 里，无害变量原样保留", () => {
		const env = scrubEnv(RUNNER_ENV, {});
		for (const k of SCRUBBED_ENV_KEYS) expect(env).not.toHaveProperty(k);
		expect(env.PATH).toBe(RUNNER_ENV.PATH);
		expect(env.HOME).toBe(RUNNER_ENV.HOME);
	});

	it("适配器的开关也不能把被清洗的键塞回去", () => {
		for (const k of SCRUBBED_ENV_KEYS)
			expect(scrubEnv(RUNNER_ENV, { [k]: "x" })).not.toHaveProperty(k);
	});

	it("不注入任何东西：子进程的键 ⊆ Runner 自己的键", () => {
		const plan = buildLaunchPlan(CONFIG, "/ws", RUNNER_ENV);
		for (const k of Object.keys(plan.env))
			expect(Object.keys(RUNNER_ENV)).toContain(k);
	});
});

describe("启动计划", () => {
	const plan = buildLaunchPlan(CONFIG, "/ws", RUNNER_ENV);

	it("command 是 /usr/bin/env，每个被清洗的键都有 -u，真实命令是参数（不经 shell）", () => {
		expect(plan.command).toBe(ENV_BIN);
		for (const k of SCRUBBED_ENV_KEYS) {
			const at = plan.args.indexOf(k);
			expect(at).toBeGreaterThan(0);
			expect(plan.args[at - 1]).toBe("-u");
		}
		expect(plan.args.slice(-3)).toEqual(["npx", ...CONFIG.args]);
		expect(plan.cwd).toBe("/ws");
	});

	it("整个计划序列化后搜不到 token 的值", () => {
		expect(JSON.stringify(plan)).not.toContain(SECRET);
	});
});

describe("启动配置的卫生判据", () => {
	it("拒绝带空格或 shell 元字符的命令、插值的 env 值、被清洗的键名", () => {
		expect(
			enforceAcpConfig({ command: "npx; rm -rf /", args: [], env: {} })
				.rejection?.reason,
		).toBe("invalid_command");
		expect(
			enforceAcpConfig({
				command: "npx",
				args: [],
				// biome-ignore lint/suspicious/noTemplateCurlyInString: 要测的正是字面的插值写法。
				env: { LEAK: "${ORGOS_RUNNER_TOKEN}" },
			}).rejection?.reason,
		).toBe("invalid_env");
		expect(
			enforceAcpConfig({
				command: "npx",
				args: [],
				env: { ORGOS_RUNNER_TOKEN: "x" },
			}).rejection?.reason,
		).toBe("invalid_env");
	});

	it("适配器表里的每一条都通过判据，且不带任何环境变量", () => {
		for (const def of ACP_ADAPTERS) {
			const config = launchConfigOf(def);
			expect(enforceAcpConfig(config).rejection).toBeNull();
			expect(config.env).toEqual({});
		}
	});
});
