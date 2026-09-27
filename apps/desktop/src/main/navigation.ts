/**
 * 聊天窗口的导航规则：只在服务器的源内导航（外加 app 自带的本地页面），
 * 外部 http/https 链接交给系统浏览器，其余一律拒绝。
 */
export type NavigationDecision = "allow" | "external" | "deny";

export function decideNavigation(
	target: string,
	serverOrigin: string | null,
	localPages: readonly string[],
): NavigationDecision {
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return "deny";
	}
	if (url.protocol === "file:") {
		url.search = "";
		url.hash = "";
		return localPages.includes(url.href) ? "allow" : "deny";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return "deny";
	if (serverOrigin !== null && url.origin === serverOrigin) return "allow";
	return "external";
}

/** Chromium 的 ERR_ABORTED：导航被新的导航取代，不算加载失败。 */
const ERR_ABORTED = -3;

/** 聊天窗口的主框架加载服务器页面失败时，是否改为显示“连不上服务器”页。 */
export function isServerLoadFailure(
	errorCode: number,
	isMainFrame: boolean,
	url: string,
	serverOrigin: string | null,
): boolean {
	if (!isMainFrame || errorCode === ERR_ABORTED || serverOrigin === null)
		return false;
	try {
		return new URL(url).origin === serverOrigin;
	} catch {
		return false;
	}
}

/** 带查询参数的本地页面地址（连不上服务器页、更换地址时的服务器地址页）。 */
export function localPageWith(
	page: string,
	params: Record<string, string>,
): string {
	const url = new URL(page);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url.href;
}
