import { env } from "@/env";

/** 内部 Next 的 WS 目标地址（保留 path 与 query），供 HMR 升级透传。 */
export function nextWsTarget(url: URL): string {
	const target = new URL(env.NEXT_INTERNAL_URL);
	const scheme = target.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${target.host}${url.pathname}${url.search}`;
}

/**
 * 反代到内部 Next 进程（浏览器不直连）。透传方法、头、请求体与响应体（流式）。
 */
export async function proxyToNext(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const target = `${env.NEXT_INTERNAL_URL}${url.pathname}${url.search}`;

	const headers = new Headers(req.headers);
	headers.set("host", new URL(env.NEXT_INTERNAL_URL).host);

	const init: RequestInit & { duplex?: "half" } = {
		method: req.method,
		headers,
		redirect: "manual",
	};
	if (req.method !== "GET" && req.method !== "HEAD") {
		init.body = req.body;
		init.duplex = "half";
	}

	const upstream = await fetch(target, init);

	// Bun 的 fetch 已自动解压响应体；透传解压后的 body 必须摘掉这些头，
	// 否则下游按头再解压一次会出错，content-length 也已失效。
	const respHeaders = new Headers(upstream.headers);
	respHeaders.delete("content-encoding");
	respHeaders.delete("content-length");
	respHeaders.delete("transfer-encoding");

	return new Response(upstream.body, {
		status: upstream.status,
		headers: respHeaders,
	});
}
