/**
 * 聊天窗口的大小与位置：存在 userData 的 window-state.json，下次启动恢复。
 * 保存的位置已不在任何屏幕上（外接屏拔掉了）时只恢复大小，由系统居中。
 */
export type Rect = { x: number; y: number; width: number; height: number };

export type WindowState = Rect & { maximized: boolean };

export const DEFAULT_SIZE = { width: 1280, height: 820 };
export const MIN_SIZE = { width: 420, height: 560 };

function isRect(v: unknown): v is Rect {
	if (!v || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	return ["x", "y", "width", "height"].every(
		(k) => typeof r[k] === "number" && Number.isFinite(r[k]),
	);
}

export function parseWindowState(raw: unknown): WindowState | null {
	if (!isRect(raw)) return null;
	const maximized = (raw as { maximized?: unknown }).maximized === true;
	return {
		x: Math.round(raw.x),
		y: Math.round(raw.y),
		width: Math.round(raw.width),
		height: Math.round(raw.height),
		maximized,
	};
}

/** 两个矩形重叠的面积。 */
function overlap(a: Rect, b: Rect): number {
	const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
}

/**
 * 由保存的状态与当前各屏幕的工作区得出窗口的初始位置与大小。
 * 标题栏一带（顶部 40px）至少有一段落在某块屏幕上才恢复位置。
 */
export function restoreBounds(
	saved: WindowState | null,
	workAreas: readonly Rect[],
): {
	bounds: Partial<Rect> & { width: number; height: number };
	maximized: boolean;
} {
	if (!saved) return { bounds: { ...DEFAULT_SIZE }, maximized: false };
	const width = Math.max(MIN_SIZE.width, saved.width);
	const height = Math.max(MIN_SIZE.height, saved.height);
	const titleBar: Rect = { x: saved.x, y: saved.y, width, height: 40 };
	const visible = workAreas.some((a) => overlap(a, titleBar) >= 40 * 40);
	return {
		bounds: visible
			? { x: saved.x, y: saved.y, width, height }
			: { width, height },
		maximized: saved.maximized,
	};
}
