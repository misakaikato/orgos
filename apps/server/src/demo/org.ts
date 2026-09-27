/**
 * 星河科技的组织结构：产品部（负责人林晓，成员陈安）、研发部（周野）、销售部（许诺）。
 * 各部门有负责人写好的章程、两三条单元资料与一条单元分身已记录的决定。经与线上相同的服务函数写入。
 */
import type { DemoCast } from "@/demo/seed";
import { postMessage } from "@/services/conversations";
import {
	addUnitMember,
	createUnit,
	type OrgActor,
	updateUnit,
} from "@/services/org";
import { createUnitNote, recordUnitDecision } from "@/services/unit-notes";

type DemoUnit = {
	handle: string;
	name: string;
	head: string;
	members: string[];
	charter: string;
	notes: { title: string; body: string; visibility: "unit" | "shared" }[];
	decision: { title: string; body: string };
	/** 负责人在部门群里的第一句话。 */
	greeting: string;
};

export const DEMO_UNITS: DemoUnit[] = [
	{
		handle: "product",
		name: "产品部",
		head: "linxiao",
		members: ["chenan"],
		charter: [
			"需求排期问题可以按《Q4 路线图》直接答复，并注明依据。",
			"已定排期内的小调整（不改变任何上线日期、不增加人日）可以直接决定，决定后记录下来。",
			"新需求插队、改变上线日期、为大客户做定制，必须问林晓。",
			"不谈人事，不评价个人。",
		].join("\n"),
		notes: [
			{
				title: "Q4 路线图",
				visibility: "shared",
				body: [
					"1. 新版结算页：支持优惠券叠加，10 月 31 日上线；10 月 24 日起灰度。设计陈安，接口周野。",
					"2. 订单服务迁移：10 月 20 日切流；20 日 00:00 至 21 日 12:00 冻结订单相关发布。",
					"3. 商家后台批量改价：后端估 5 人日，排进 11 月第一个迭代。",
					"不在 Q4 范围：会员积分改版、海外站点、大客户 A 的定制需求（11 月评估）。",
				].join("\n"),
			},
			{
				title: "需求插队规则",
				visibility: "shared",
				body: [
					"当前迭代已锁定的范围不接受新增需求，除非林晓确认。",
					"申请插队请写清：需求内容、客户与金额、期望日期、不做的代价。",
					"评估口径：只看是否影响已定上线日期与关键人力，影响任何一项即推到下个迭代。",
				].join("\n"),
			},
			{
				title: "10 月迭代排期（部门内部）",
				visibility: "unit",
				body: [
					"10 月 8 日—10 月 21 日：结算页联调与走查，陈安 10 月 14 日前交走查清单。",
					"10 月 22 日—10 月 31 日：灰度与全量，每天 10:00 看转化与报错。",
					"陈安 10 月 16 日至 18 日请假，走查由林晓顶上。",
				].join("\n"),
			},
		],
		decision: {
			title: "结算页灰度比例定为 10%",
			body: "新版结算页 10 月 24 日起按 10% 流量灰度，观察两天转化与报错再放量；依据章程第 2 条（不改变上线日期）。",
		},
		greeting:
			"产品部的群建好了。部门的分身已经上岗：别的部门问排期，它按路线图直接答；插队的需求它会转给我。",
	},
	{
		handle: "rd",
		name: "研发部",
		head: "zhouye",
		members: [],
		charter: [
			"技术方案、接口字段、订单服务迁移进度可以直接答复。",
			"联调、评审等时间可以在周二至周四的下午（14:00—18:00）直接约定，一次不超过 90 分钟；10 月 20 日、21 日切流窗口不约任何联调。",
			"上线日期、切流时间的变更，以及需要加人日的事，必须问周野。",
		].join("\n"),
		notes: [
			{
				title: "接口变更流程",
				visibility: "shared",
				body: [
					"字段新增：提前两个工作日在群里通知，预发先上。",
					"字段删除或改名：保留旧字段一个迭代，双写后下线。",
					"联调环境：预发 pre.xinghe.local，测试账号向研发部申请。",
				].join("\n"),
			},
			{
				title: "联调日历（部门内部）",
				visibility: "unit",
				body: [
					"10 月 13 日—10 月 16 日下午：结算页联调，已约产品部。",
					"10 月 15 日晚：全量对账，约 6 小时，当晚不接联调。",
					"10 月 20 日—21 日：切流窗口，冻结。",
				].join("\n"),
			},
		],
		decision: {
			title: "切流前 48 小时冻结订单相关发布",
			body: "10 月 18 日 00:00 起冻结订单相关发布，直到 21 日 12:00 切流完成；依据章程第 1 条（迁移方案可直接答复）。",
		},
		greeting:
			"研发部的群。部门分身按章程约联调时间，切流相关的变更它会转给我。",
	},
	{
		handle: "sales",
		name: "销售部",
		head: "xunuo",
		members: [],
		charter: [
			"报价区间与客户进展可以直接答复。",
			"和其他部门约联调、演示时间可以直接定，工作日 10:00—18:00 之间。",
			"折扣低于 9 折、合同条款、对客户的交付承诺，必须问许诺。",
		].join("\n"),
		notes: [
			{
				title: "报价单模板说明",
				visibility: "shared",
				body: [
					"标准版 72–90 万元（不含税），按门店数分档。",
					"报价单统一用销售部模板，附件带交付范围与验收标准。",
				].join("\n"),
			},
			{
				title: "大客户 A 跟进节奏（部门内部）",
				visibility: "unit",
				body: [
					"10 月 8 日前给客户正式答复交付日期。",
					"客户希望 10 月 15 日前看到结算页演示；可以用预发环境演示。",
					"客户 CTO 关心迁移期间的订单稳定性，演示时请研发在场。",
				].join("\n"),
			},
		],
		decision: {
			title: "大客户 A 试用走预发环境",
			body: "大客户 A 的试用与演示统一走预发环境，不开放生产账号；依据章程第 2 条（演示安排可直接定）。",
		},
		greeting: "销售部的群。客户那边的进展我会同步在这里。",
	},
];

export async function writeDemoOrg(cast: DemoCast, now: Date): Promise<void> {
	const { s } = cast;
	const owner: OrgActor = { me: cast.human("linxiao"), tenantRole: "owner" };
	const at = (hoursAgo: number) =>
		new Date(now.getTime() - hoursAgo * 3_600_000);
	for (const [i, spec] of DEMO_UNITS.entries()) {
		const head = cast.human(spec.head);
		const unit = await createUnit(
			s,
			owner,
			{ name: spec.name, handle: spec.handle, headId: head.id },
			{ at: at(72 - i) },
		);
		if (unit.groupId)
			await postMessage(
				s,
				head,
				unit.groupId,
				{ text: spec.greeting },
				at(71 - i),
			);
		for (const handle of spec.members)
			await addUnitMember(s, owner, unit.unit.id, {
				principalId: cast.human(handle).id,
				isPrimary: true,
			});
		const byHead: OrgActor = { me: head, tenantRole: "member" };
		await updateUnit(s, byHead, unit.unit.id, { charter: spec.charter });
		for (const note of spec.notes)
			await createUnitNote(s, byHead, unit.unit.id, note);
		await recordUnitDecision(s, {
			unitId: unit.unit.id,
			authorId: unit.twin.id,
			title: spec.decision.title,
			body: spec.decision.body,
			at: at(30 - i),
		});
	}
}
