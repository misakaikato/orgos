import { describe, expect, it } from "vitest";
import { approvalDetails, capabilityLabel } from "@/lib/device";

describe("设备能力的展示", () => {
	it("能力名取 protocol 里的说法，未知的原样显示", () => {
		expect(capabilityLabel("shell.exec")).toBe("执行命令");
		expect(capabilityLabel("fs.write")).toBe("写入文件");
		expect(capabilityLabel("agent.acp")).toBe("agent.acp");
	});

	it("命令与写入内容放等宽块，路径作正文", () => {
		expect(approvalDetails("shell.exec", { command: "ls -la" })).toEqual({
			code: "ls -la",
		});
		expect(
			approvalDetails("fs.write", { path: "a/b.txt", content: "你好" }),
		).toEqual({ path: "a/b.txt", code: "你好" });
		expect(approvalDetails("fs.read", { path: "x" })).toEqual({ path: "x" });
	});
});
