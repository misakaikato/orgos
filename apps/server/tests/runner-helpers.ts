/**
 * 设备测试的共用动作：以设备身份连上 `/runner/ws`（假连接），可自动应答 invoke。
 */
import {
	deviceCapabilityList,
	parseRunnerDown,
	type RunnerDown,
	type RunnerUp,
} from "@orgos/protocol";
import { WSContext } from "hono/ws";
import type { runners } from "@/db/schema";
import { runnerWsEvents } from "@/realtime/runner-ws";

type Invoke = Extract<RunnerDown, { t: "invoke" }>;
type Result = Omit<Extract<RunnerUp, { t: "result" }>, "t" | "jobId">;

export type FakeRunner = {
	down: RunnerDown[];
	closed: { code?: number; reason?: string } | null;
	up(frame: unknown): Promise<void>;
	close(): Promise<void>;
};

export const HELLO = {
	t: "hello",
	protocol: 1,
	runnerVersion: "test",
	os: "macOS arm64",
	hostname: "test-host",
	workspace: "/tmp/ws",
	capabilities: deviceCapabilityList(),
} as const;

/**
 * 以设备身份连上（鉴权已通过）。给了 `respond` 时，每个 invoke 都由它算出结果并交回。
 */
export function connectRunner(
	row: typeof runners.$inferSelect,
	respond?: (invoke: Invoke) => Result,
): FakeRunner {
	const events = runnerWsEvents(row);
	const conn: FakeRunner = {
		down: [],
		closed: null,
		up: async (frame) => {
			await events.onMessage?.(
				new MessageEvent("message", { data: JSON.stringify(frame) }),
				ws,
			);
		},
		close: async () => {
			await events.onClose?.(new CloseEvent("close"), ws);
		},
	};
	const ws = new WSContext({
		readyState: 1,
		send: (data) => {
			const parsed = parseRunnerDown(String(data));
			if (!parsed.ok) throw new Error(parsed.error);
			conn.down.push(parsed.data);
			const frame = parsed.data;
			if (frame.t === "invoke" && respond) {
				const result = respond(frame);
				queueMicrotask(
					() => void conn.up({ t: "result", jobId: frame.jobId, ...result }),
				);
			}
		},
		close: (code, reason) => {
			conn.closed = { code, reason };
		},
	});
	events.onOpen?.(new Event("open"), ws);
	return conn;
}
