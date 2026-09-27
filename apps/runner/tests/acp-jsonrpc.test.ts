import { describe, expect, it } from "bun:test";
import {
	classify,
	createJsonRpcPeer,
	createNdjsonDecoder,
	encodeFrame,
} from "@/acp/jsonrpc";

describe("NDJSON 分帧", () => {
	it("跨 chunk 的半行留到下一次；空行跳过；坏行原样交出", () => {
		const decode = createNdjsonDecoder();
		expect(decode('{"jsonrpc":"2.0","id":1,')).toEqual([]);
		const out = decode('"result":{}}\n\nnot json\n');
		expect(out[0]).toEqual({
			ok: true,
			message: { jsonrpc: "2.0", id: 1, result: {} },
		});
		expect(out[1]).toMatchObject({ ok: false, raw: "not json" });
	});

	it("编码带换行；分类按 method / id 判", () => {
		expect(encodeFrame({ jsonrpc: "2.0", method: "x" })).toBe(
			'{"jsonrpc":"2.0","method":"x"}\n',
		);
		expect(classify({ jsonrpc: "2.0", id: 1, method: "a" })).toBe("request");
		expect(classify({ jsonrpc: "2.0", method: "a" })).toBe("notification");
		expect(classify({ jsonrpc: "2.0", id: 1, result: {} })).toBe("response");
		expect(classify({ jsonrpc: "2.0" })).toBe("invalid");
	});
});

describe("对等体", () => {
	it("请求等响应；对方的请求交给 handle 并回结果或错误", async () => {
		const written: string[] = [];
		const peer = createJsonRpcPeer({
			write: (f) => written.push(f),
			handle: async (method) => {
				if (method === "boom") throw new Error("坏了");
				return { echoed: method };
			},
		});
		const p = peer.request("initialize", { v: 1 });
		expect(JSON.parse(written[0] ?? "")).toMatchObject({
			id: 1,
			method: "initialize",
		});
		peer.feed('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
		expect(await p).toEqual({ ok: true });
		peer.feed('{"jsonrpc":"2.0","id":"a","method":"fs/x"}\n');
		peer.feed('{"jsonrpc":"2.0","id":"b","method":"boom"}\n');
		await Bun.sleep(10);
		expect(JSON.parse(written[1] ?? "")).toEqual({
			jsonrpc: "2.0",
			id: "a",
			result: { echoed: "fs/x" },
		});
		expect(JSON.parse(written[2] ?? "")).toMatchObject({
			id: "b",
			error: { message: "坏了" },
		});
	});

	it("rejectAll 作废挂起的请求，之后的请求直接失败", async () => {
		const peer = createJsonRpcPeer({
			write: () => {},
			handle: async () => ({}),
		});
		const p = peer.request("session/prompt");
		peer.rejectAll(new Error("进程没了"));
		await expect(p).rejects.toThrow("进程没了");
		await expect(peer.request("x")).rejects.toThrow();
		expect(peer.pendingCount()).toBe(0);
	});
});
