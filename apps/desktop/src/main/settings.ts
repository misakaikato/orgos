/**
 * app 自己的设置：userData 下的 settings.json。配对信息不在这里（只在 Runner 的 runner.json）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Settings = {
	/** 服务器地址（origin）；null 表示第一次启动、还没填过。 */
	serverUrl: string | null;
	/** Runner 的工作目录。 */
	workspace: string;
	/** 启用的适配器 id；null 表示全部。 */
	adapters: string[] | null;
	/** app 启动时是否自动启动 Runner（已配对时）。 */
	autoStartRunner: boolean;
	/** 开机自启。 */
	openAtLogin: boolean;
};

export function defaultSettings(home: string): Settings {
	return {
		serverUrl: null,
		workspace: path.join(home, "orgos-workspace"),
		adapters: null,
		autoStartRunner: true,
		openAtLogin: false,
	};
}

/**
 * 用户输入的服务器地址 → origin。允许省略协议（按 http），只接受 http 与 https；
 * 不合法返回 null。
 */
export function normalizeServerUrl(input: string): string | null {
	const text = input.trim();
	if (!text) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
		? text
		: `http://${text}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (!url.hostname) return null;
	return url.origin;
}

/** 从磁盘内容得出设置：缺的与不合法的字段取默认值。 */
export function parseSettings(raw: unknown, home: string): Settings {
	const d = defaultSettings(home);
	if (!raw || typeof raw !== "object") return d;
	const r = raw as Record<string, unknown>;
	const serverUrl =
		typeof r.serverUrl === "string" ? normalizeServerUrl(r.serverUrl) : null;
	const workspace =
		typeof r.workspace === "string" && path.isAbsolute(r.workspace)
			? r.workspace
			: d.workspace;
	const adapters =
		Array.isArray(r.adapters) && r.adapters.every((a) => typeof a === "string")
			? [...new Set(r.adapters as string[])]
			: null;
	return {
		serverUrl,
		workspace,
		adapters,
		autoStartRunner:
			typeof r.autoStartRunner === "boolean"
				? r.autoStartRunner
				: d.autoStartRunner,
		openAtLogin:
			typeof r.openAtLogin === "boolean" ? r.openAtLogin : d.openAtLogin,
	};
}

/** `serve --adapters` 的取值：null 表示不传（全部），空列表为 none。 */
export function adaptersFlag(adapters: string[] | null): string | null {
	if (adapters === null) return null;
	return adapters.length === 0 ? "none" : adapters.join(",");
}

export class SettingsStore {
	private value: Settings;

	constructor(
		private readonly file: string,
		home: string,
	) {
		let raw: unknown = null;
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			raw = null;
		}
		this.value = parseSettings(raw, home);
	}

	get(): Settings {
		return this.value;
	}

	update(patch: Partial<Settings>): Settings {
		this.value = { ...this.value, ...patch };
		mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(this.value, null, "\t")}\n`);
		renameSync(tmp, this.file);
		return this.value;
	}
}
