/**
 * 菜单栏的单色模板图标（只有黑色与透明度，macOS 按菜单栏深浅自动着色），按 Runner 状态区分：
 *   已连接   实心圆
 *   重连中   断开两处的圆环
 *   已停止   空心圆环
 *   未配对   圆环加一道斜线
 * 直接生成位图，不依赖图片资源文件。
 */
import type { RunnerPhase } from "@/main/supervisor";

/** 图标的逻辑尺寸（点）。 */
export const TRAY_POINTS = 16;

const CENTER = TRAY_POINTS / 2;
const OUTER = 6;
const STROKE = 1.5;

type Shape = (x: number, y: number) => boolean;

const disc: Shape = (x, y) => Math.hypot(x - CENTER, y - CENTER) <= OUTER;

const ring: Shape = (x, y) => {
	const d = Math.hypot(x - CENTER, y - CENTER);
	return d <= OUTER && d >= OUTER - STROKE;
};

/** 圆环在右上与左下各断开一段（各约 50°）。 */
const brokenRing: Shape = (x, y) => {
	if (!ring(x, y)) return false;
	const deg = (Math.atan2(y - CENTER, x - CENTER) * 180) / Math.PI;
	const gap = (center: number) =>
		Math.abs(((deg - center + 540) % 360) - 180) < 25;
	return !gap(-45) && !gap(135);
};

/** 从左下到右上的斜线（与圆环同宽）。 */
const slash: Shape = (x, y) => {
	const dx = x - CENTER;
	const dy = y - CENTER;
	const along = (dx - dy) / Math.SQRT2;
	const across = (dx + dy) / Math.SQRT2;
	return Math.abs(across) <= STROKE / 2 + 0.1 && Math.abs(along) <= OUTER + 0.5;
};

const SHAPES: Record<RunnerPhase, Shape> = {
	connected: disc,
	reconnecting: brokenRing,
	stopped: ring,
	unpaired: (x, y) => ring(x, y) || slash(x, y),
};

/**
 * 画出某状态的图标：返回 scale 倍像素的 BGRA 位图（颜色通道全 0，只有 alpha）。
 * 每个像素 4×4 超采样抗锯齿。
 */
export function trayBitmap(phase: RunnerPhase, scale: number): Buffer {
	const size = TRAY_POINTS * scale;
	const shape = SHAPES[phase];
	const buf = Buffer.alloc(size * size * 4);
	const sub = 4;
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let hits = 0;
			for (let sy = 0; sy < sub; sy++) {
				for (let sx = 0; sx < sub; sx++) {
					const x = (px + (sx + 0.5) / sub) / scale;
					const y = (py + (sy + 0.5) / sub) / scale;
					if (shape(x, y)) hits += 1;
				}
			}
			buf[(py * size + px) * 4 + 3] = Math.round((hits / (sub * sub)) * 255);
		}
	}
	return buf;
}

export const PHASE_LABEL: Record<RunnerPhase, string> = {
	connected: "已连接",
	reconnecting: "重连中",
	stopped: "已停止",
	unpaired: "未配对",
};
