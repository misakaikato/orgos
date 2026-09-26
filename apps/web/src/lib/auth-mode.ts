/**
 * 身份凭据的两种模式。
 *
 * - cookie（默认）：better-auth 会话 cookie，同源请求自动携带。
 * - bearer：页面地址带 `?as=<会话 token>`。token 只存在内存（不写 cookie / localStorage），
 *   REST 带 `Authorization: Bearer`，WS 连 `/ws?token=`；站内跳转保留 `as` 参数，刷新后身份不变。
 *   同源的多个窗格（模拟台）因此互不串身份。
 */

export const BEARER_PARAM = "as";

/** 从查询串读 bearer token；没有则为 null（cookie 模式）。 */
export function readBearerToken(search: string): string | null {
	const token = new URLSearchParams(search).get(BEARER_PARAM);
	return token ? token : null;
}

let token: string | null | undefined;

/** 当前页面的 bearer token（首次调用时从地址栏读取并留在内存）。 */
export function bearerToken(): string | null {
	if (token === undefined) {
		token =
			typeof window === "undefined"
				? null
				: readBearerToken(window.location.search);
	}
	return token;
}

/** REST 请求的鉴权头；cookie 模式为空。 */
export function authHeaders(
	t: string | null = bearerToken(),
): Record<string, string> {
	return t ? { authorization: `Bearer ${t}` } : {};
}

/** 浏览器 WS 地址：与页面同源，bearer 模式带 `?token=`。 */
export function wsUrl(
	location: { protocol: string; host: string },
	t: string | null = bearerToken(),
): string {
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	const query = t ? `?token=${encodeURIComponent(t)}` : "";
	return `${scheme}//${location.host}/ws${query}`;
}

/** 站内链接：bearer 模式下保留 `as` 参数。 */
export function appHref(
	path: string,
	t: string | null = bearerToken(),
): string {
	if (!t) return path;
	const [base = "", hash] = path.split("#", 2);
	const [pathname = "", query = ""] = base.split("?", 2);
	const params = new URLSearchParams(query);
	params.set(BEARER_PARAM, t);
	return `${pathname}?${params.toString()}${hash === undefined ? "" : `#${hash}`}`;
}
