/**
 * Runner 日志：一行一条写到 stderr。token 与文件内容绝不进日志。
 */
type Fields = Record<string, unknown>;

function write(level: string, msg: string, fields?: Fields): void {
	const extra =
		fields && Object.keys(fields).length > 0
			? ` ${JSON.stringify(fields)}`
			: "";
	process.stderr.write(`${new Date().toISOString()} ${level} ${msg}${extra}\n`);
}

export const log = {
	debug: (msg: string, fields?: Fields) => {
		if (process.env.ORGOS_RUNNER_DEBUG === "1") write("debug", msg, fields);
	},
	info: (msg: string, fields?: Fields) => write("info", msg, fields),
	warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
	error: (msg: string, fields?: Fields) => write("error", msg, fields),
};

export function errFields(err: unknown): Fields {
	return err instanceof Error ? { error: err.message } : { error: String(err) };
}
