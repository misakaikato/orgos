/** 时间与数字的显示格式（等宽 + tabular-nums 由组件负责）。 */

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** 列表里的时间：今天 HH:mm；今年 M月D日；更早 YYYY/M/D。 */
export function formatListTime(iso: string, now = new Date()): string {
	const d = new Date(iso);
	if (d.toDateString() === now.toDateString()) {
		return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
	if (d.getFullYear() === now.getFullYear()) {
		return `${d.getMonth() + 1}月${d.getDate()}日`;
	}
	return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 消息旁的时间：HH:mm。 */
export function formatClock(iso: string): string {
	const d = new Date(iso);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 日期分隔条：今天 / 昨天 / M月D日 星期X。 */
export function formatDay(iso: string, now = new Date()): string {
	const d = new Date(iso);
	const startOf = (x: Date) =>
		new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
	if (diff === 0) return "今天";
	if (diff === 1) return "昨天";
	const week = "日一二三四五六"[d.getDay()];
	const year =
		d.getFullYear() === now.getFullYear() ? "" : `${d.getFullYear()}年`;
	return `${year}${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
}

export function sameDay(a: string, b: string): boolean {
	return new Date(a).toDateString() === new Date(b).toDateString();
}

/** 未读数显示：超过 99 显示 99+。 */
export function formatCount(n: number): string {
	return n > 99 ? "99+" : String(n);
}
