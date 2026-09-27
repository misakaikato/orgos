import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOG_KEEP_FILES, LOG_MAX_BYTES, RotatingLog } from "@/main/log-file";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "orgos-desktop-log-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("日志轮转", () => {
	it("默认单文件 5MB、共保留 3 个", () => {
		expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
		expect(LOG_KEEP_FILES).toBe(3);
	});

	it("自动建目录，写满即轮转，最多保留 keep 个文件", () => {
		const file = path.join(dir, "logs", "runner.log");
		const log = new RotatingLog(file, 20, 3);
		for (const n of [1, 2, 3, 4, 5, 6, 7]) log.write(`line-${n}-xxxx\n`);
		expect(log.files()).toEqual([file, `${file}.1`, `${file}.2`]);
		expect(existsSync(`${file}.3`)).toBe(false);
		expect(readFileSync(file, "utf8")).toBe("line-7-xxxx\n");
		expect(readFileSync(`${file}.1`, "utf8")).toBe("line-6-xxxx\n");
		expect(readFileSync(`${file}.2`, "utf8")).toBe("line-5-xxxx\n");
	});

	it("未满时追加在同一个文件里", () => {
		const file = path.join(dir, "runner.log");
		const log = new RotatingLog(file, 100, 3);
		log.write("a\n");
		log.write("b\n");
		expect(readFileSync(file, "utf8")).toBe("a\nb\n");
		expect(log.files()).toEqual([file]);
	});

	it("接着已有文件的大小计算（重启 app 后不从零算）", () => {
		const file = path.join(dir, "runner.log");
		writeFileSync(file, "0123456789012345\n");
		const log = new RotatingLog(file, 20, 3);
		log.write("new-line\n");
		expect(readFileSync(file, "utf8")).toBe("new-line\n");
		expect(readFileSync(`${file}.1`, "utf8")).toBe("0123456789012345\n");
	});

	it("单条超过上限也照写（写进新文件）", () => {
		const file = path.join(dir, "runner.log");
		const log = new RotatingLog(file, 10, 2);
		log.write("short\n");
		log.write("a very long line over limit\n");
		expect(readFileSync(file, "utf8")).toBe("a very long line over limit\n");
		expect(log.files()).toEqual([file, `${file}.1`]);
	});
});
