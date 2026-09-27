/**
 * ACP `fs/*` → 任务工作目录里的文件。
 *
 * 外部 agent 的读写工具不是它自己去碰磁盘，而是经 ACP 回调到 Runner（前提是我们声明了 fs 能力）。
 * 路径防护是这条通路上唯一的门，它与设备四项能力是同一把：`@/workspace` 的
 * `resolveExisting` / `resolveForWrite`（`../` 越界、工作目录外的绝对路径、符号链接逃逸一律拒绝）。
 * 第二套判据 = 第二套漏洞，这里一行新的路径逻辑都不写。
 */
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AcpReadTextFileParams, AcpWriteTextFileParams } from "@/acp/wire";
import { resolveExisting, resolveForWrite, WorkspaceError } from "@/workspace";

/** 单次读取的上限：超过直接拒绝而不是截断（截断后 agent 会以为读到了全文，再基于半个文件去改它）。 */
export const ACP_READ_MAX_BYTES = 1024 * 1024;

/**
 * `fs/read_text_file`。`line`（1 起）与 `limit` 是 ACP 的分页参数：agent 读大文件的一段时会用。
 */
export async function acpReadTextFile(
	workspace: string,
	params: AcpReadTextFileParams,
): Promise<{ content: string }> {
	const file = await resolveExisting(workspace, params.path ?? "");
	const st = await lstat(file);
	if (st.isDirectory()) throw new WorkspaceError(`${params.path} 是目录`);
	if (st.size > ACP_READ_MAX_BYTES)
		throw new WorkspaceError(
			`${params.path} 太大（${st.size} 字节，上限 ${ACP_READ_MAX_BYTES}）`,
		);
	const text = await readFile(file, "utf8");
	const { line, limit } = params;
	if (typeof line !== "number" && typeof limit !== "number")
		return { content: text };
	const lines = text.split("\n");
	const from = Math.max(1, typeof line === "number" ? line : 1) - 1;
	const count =
		typeof limit === "number" && limit > 0 ? limit : lines.length - from;
	return { content: lines.slice(from, from + count).join("\n") };
}

/**
 * `fs/write_text_file`。父目录不存在就在工作目录内建（agent 写文件前先建目录是它的正常工作方式，
 * ACP 里也没有 mkdir）。返回写入文件相对工作目录的路径（产出列表用）。
 */
export async function acpWriteTextFile(
	workspace: string,
	params: AcpWriteTextFileParams,
): Promise<string> {
	const file = await resolveForWrite(workspace, params.path ?? "");
	await writeFile(file, params.content ?? "", "utf8");
	return path.relative(workspace, file);
}
