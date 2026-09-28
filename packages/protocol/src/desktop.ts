/**
 * 桌面客户端（apps/desktop）的聊天窗口 preload 暴露给页面的 `window.orgosDesktop`：
 * 桌面端实现、Web 端（lib/desktop.ts）调用，共用这一处类型。只有类型，不做运行时校验。
 */

/** 桥接调用的结果。 */
export type BridgeResult =
	| { ok: true; message?: string }
	| { ok: false; message: string };

/**
 * 本机 Runner 的身份：是否开启"本机作为 Runner"，以及 runner.json 里的 server 与 runnerId
 * （客户端不读 token）。
 */
export type RunnerIdentity = {
	enabled: boolean;
	paired: boolean;
	server: string | null;
	runnerId: string | null;
};

export interface OrgosDesktopApi {
	setBadge(count: number): void;
	focus(): void;
	/** 以下三项只在服务器源上的页面存在（主进程另外核对发送方的源）。 */
	runnerIdentity?: () => Promise<RunnerIdentity>;
	/** 用本人刚生成的一次性配对码把本机配对到当前服务器，配好后启动 Runner。 */
	pairRunner?: (code: string) => Promise<BridgeResult>;
	/** "本机作为 Runner"被打开时回调，页面据此重新检查是否需要配对。 */
	onRunnerEnabled?: (fn: () => void) => void;
	/** 只在第一次启动的服务器地址页上存在。 */
	saveServer?: (url: string) => Promise<BridgeResult>;
}
