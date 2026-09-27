/**
 * 按大小轮转的日志文件：写满 maxBytes 就把 `x.log` 挪成 `x.log.1`（旧的 `.1` 挪成 `.2`……），
 * 连同当前文件一共保留 keep 个。
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import path from "node:path";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP_FILES = 3;

export class RotatingLog {
	private size: number;

	constructor(
		readonly file: string,
		private readonly maxBytes = LOG_MAX_BYTES,
		private readonly keep = LOG_KEEP_FILES,
	) {
		mkdirSync(path.dirname(file), { recursive: true });
		this.size = existsSync(file) ? statSync(file).size : 0;
	}

	write(text: string): void {
		const bytes = Buffer.byteLength(text);
		if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
		appendFileSync(this.file, text);
		this.size += bytes;
	}

	/** 当前文件与轮转出的旧文件，新的在前。 */
	files(): string[] {
		return [this.file, ...this.olderNames()].filter((f) => existsSync(f));
	}

	private olderNames(): string[] {
		return Array.from(
			{ length: this.keep - 1 },
			(_, i) => `${this.file}.${i + 1}`,
		);
	}

	private rotate(): void {
		const older = this.olderNames();
		const oldest = older.at(-1);
		if (oldest === undefined) {
			rmSync(this.file, { force: true });
		} else {
			rmSync(oldest, { force: true });
			for (let i = older.length - 1; i > 0; i--) {
				const from = older[i - 1];
				const to = older[i];
				if (from && to && existsSync(from)) renameSync(from, to);
			}
			if (existsSync(this.file)) renameSync(this.file, older[0] ?? oldest);
		}
		this.size = 0;
	}
}
