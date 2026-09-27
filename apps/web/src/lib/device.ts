/**
 * 设备能力在界面上的说法与参数展示（审批卡片、待办页、设备页共用）。
 */
import {
	type ApprovalOutcome,
	DEVICE_CAPABILITIES,
	type DeviceCapabilityName,
} from "@orgos/protocol";

function known(name: string): name is DeviceCapabilityName {
	return Object.hasOwn(DEVICE_CAPABILITIES, name);
}

/** “执行命令”“写入文件”……未知能力原样显示。 */
export function capabilityLabel(name: string): string {
	return known(name) ? DEVICE_CAPABILITIES[name].label : name;
}

/** 审批卡片展示的完整参数：路径用正文，命令与写入内容用等宽块。 */
export type ApprovalDetails = { path?: string; code?: string };

export function approvalDetails(
	capability: string,
	args: unknown,
): ApprovalDetails {
	const a = (args ?? {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	switch (capability) {
		case "shell.exec":
			return { code: str(a.command) ?? "" };
		case "fs.write":
			return { path: str(a.path), code: str(a.content) ?? "" };
		case "fs.list":
		case "fs.read":
			return { path: str(a.path) };
		default:
			return { code: JSON.stringify(args, null, 2) };
	}
}

export const APPROVAL_OUTCOME_LABEL: Record<ApprovalOutcome, string> = {
	approve: "已允许",
	deny: "已拒绝",
	expired: "已过期",
	cancelled: "已取消",
};
