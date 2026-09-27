/**
 * 从 Runner 的日志行得出连接状态。Runner 的日志格式见 apps/runner/src/log.ts：
 *   `<ISO 时间> <级别> <事件名> [<JSON 字段>]`
 * 不符合该格式的行（例如命令行报错）原样写进日志文件，不参与状态推导。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
	time: string;
	level: LogLevel;
	event: string;
	fields: Record<string, unknown>;
};

const LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function parseLogLine(line: string): LogEntry | null {
	const trimmed = line.trimEnd();
	const first = trimmed.indexOf(" ");
	const second = trimmed.indexOf(" ", first + 1);
	if (first < 0 || second < 0) return null;
	const time = trimmed.slice(0, first);
	const level = trimmed.slice(first + 1, second);
	if (!ISO_RE.test(time) || !LEVELS.has(level)) return null;
	const rest = trimmed.slice(second + 1);
	const third = rest.indexOf(" ");
	const event = third < 0 ? rest : rest.slice(0, third);
	if (!event) return null;
	let fields: Record<string, unknown> = {};
	if (third >= 0) {
		try {
			const parsed: unknown = JSON.parse(rest.slice(third + 1));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
				fields = parsed as Record<string, unknown>;
			else return null;
		} catch {
			return null;
		}
	}
	return { time, level: level as LogLevel, event, fields };
}

/** 一次 serve 进程生命期内由日志推出的连接状态。 */
export type LinkState = {
	link: "starting" | "connecting" | "connected" | "reconnecting";
	/** 最近一次连上服务端的时间（ISO）。 */
	lastConnectedAt: string | null;
	/** 正在执行的设备操作数。 */
	jobs: number;
	/** 外部助手会话数。 */
	sessions: number;
	/** 最近一条警告或错误的事件名与原因。 */
	lastProblem: string | null;
};

export const INITIAL_LINK: LinkState = {
	link: "starting",
	lastConnectedAt: null,
	jobs: 0,
	sessions: 0,
	lastProblem: null,
};

function count(v: unknown): number | null {
	return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function problemOf(entry: LogEntry): string {
	const detail =
		entry.fields.reason ?? entry.fields.error ?? entry.fields.message;
	return typeof detail === "string" && detail
		? `${entry.event}：${detail}`
		: entry.event;
}

export function reduceLink(state: LinkState, entry: LogEntry): LinkState {
	switch (entry.event) {
		case "ws.connecting":
			return {
				...state,
				link: state.lastConnectedAt === null ? "connecting" : "reconnecting",
			};
		case "ws.open":
			return { ...state, link: "connected", lastConnectedAt: entry.time };
		case "ws.disconnected":
			return { ...state, link: "reconnecting", lastProblem: problemOf(entry) };
		case "load": {
			const jobs = count(entry.fields.jobs);
			const sessions = count(entry.fields.sessions);
			return {
				...state,
				jobs: jobs ?? state.jobs,
				sessions: sessions ?? state.sessions,
			};
		}
		default:
			if (entry.level === "warn" || entry.level === "error")
				return { ...state, lastProblem: problemOf(entry) };
			return state;
	}
}

/** 把任意切分的输出块拼成完整的行。 */
export class LineSplitter {
	private rest = "";

	push(chunk: string): string[] {
		const text = this.rest + chunk;
		const lines = text.split("\n");
		this.rest = lines.pop() ?? "";
		return lines.map((l) => l.replace(/\r$/, ""));
	}

	/** 流结束：交出最后一段不带换行的内容。 */
	flush(): string[] {
		const last = this.rest;
		this.rest = "";
		return last ? [last] : [];
	}
}
