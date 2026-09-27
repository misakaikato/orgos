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
