import { describe, expect, it } from "vitest";
import { appHref, authHeaders, readBearerToken, wsUrl } from "@/lib/auth-mode";

const loc = { protocol: "http:", host: "localhost:8930" };

describe("cookie 模式（无 ?as=）", () => {
	it("不带鉴权头，WS 不带 token，链接不改写", () => {
		expect(readBearerToken("?c=1")).toBeNull();
		expect(readBearerToken("?as=")).toBeNull();
		expect(authHeaders(null)).toEqual({});
		expect(wsUrl(loc, null)).toBe("ws://localhost:8930/ws");
		expect(appHref("/c/abc", null)).toBe("/c/abc");
	});
});

describe("bearer 模式（?as=<token>）", () => {
	const token = "tok.en+/=";

	it("从查询串读 token", () => {
		expect(readBearerToken(`?x=1&as=${encodeURIComponent(token)}`)).toBe(token);
	});

	it("REST 带 Authorization: Bearer", () => {
		expect(authHeaders(token)).toEqual({ authorization: `Bearer ${token}` });
	});

	it("WS 连 /ws?token=（编码后）", () => {
		expect(wsUrl(loc, token)).toBe(
			`ws://localhost:8930/ws?token=${encodeURIComponent(token)}`,
		);
		expect(wsUrl({ protocol: "https:", host: "x.test" }, "t")).toBe(
			"wss://x.test/ws?token=t",
		);
	});

	it("站内链接保留 as，并保留已有查询与锚点", () => {
		const href = appHref("/c/abc?view=info#bottom", token);
		const url = new URL(href, "http://localhost");
		expect(url.pathname).toBe("/c/abc");
		expect(url.searchParams.get("view")).toBe("info");
		expect(url.searchParams.get("as")).toBe(token);
		expect(url.hash).toBe("#bottom");
	});
});
