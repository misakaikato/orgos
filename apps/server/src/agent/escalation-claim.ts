/**
 * 上报的运行时校验：判定代理回复是否声称已把问题转交本人（拍板人）。
 * 运行循环据此在落回复前纠正"口头转交却没调用 escalate_to_owner"；真实模型冒烟用同一个判定。
 */

/** 纠正提示：放在模型那条回复之后，让它再走一步。 */
export const ESCALATION_CLAIM_CORRECTION =
	"【系统】你的回复说已经转交本人，但本轮没有调用 escalate_to_owner。需要本人决定就调用它；否则改写回复，不要说已经转交。";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 回复里是否有"已转给 / 转交 / 已上报 / 报给本人 / 问过本人"之类的表述；deciderName 为本人或单元负责人的显示名。 */
export function claimsEscalated(text: string, deciderName: string): boolean {
	const who = deciderName.trim()
		? `本人|${escapeRegExp(deciderName.trim())}`
		: "本人";
	return new RegExp(
		`转给|转交|已上报|上报给|(?:报给|问过|通知了?)(?:${who})`,
	).test(text);
}
