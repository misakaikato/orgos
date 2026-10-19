/**
 * 触发 WSContext 的 onClose 时用的事件对象。
 *
 * 处理函数只看连接本身、不看事件内容，所以用对象字面量即可：
 * `CloseEvent` 不是所有 Node 版本都提供的全局（CI 的 node 上没有，本地较新的 node / bun 才有），
 * 直接 `new CloseEvent(...)` 会在换环境后挂掉。
 *
 * 单独成文件、不引入 `@/index`：`helpers.ts` 会初始化整个 app，测试工具不该顺带拉起它。
 */
export function closeEvent(code = 1000): CloseEvent {
	return { type: "close", code, reason: "", wasClean: true } as CloseEvent;
}
