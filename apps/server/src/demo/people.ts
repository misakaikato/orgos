/**
 * 演示租户的人物表：姓名、岗位、两个代理的职责说明、分身的对外政策与本人共享的资料。
 * 模拟台的人物列表、seed:demo、/api/dev/sessions 都以此为准。
 */

import type { PrincipalStatus } from "@orgos/protocol";

export type DemoNote = { title: string; body: string };

export type DemoPersonSpec = {
	handle: string;
	displayName: string;
	title: string;
	twinDescription: string;
	opsDescription: string;
	delegationPolicy: string;
	/** 演示开始时的在线状态（缺省为在线）。 */
	status?: PrincipalStatus;
	sharedNotes: DemoNote[];
};

export type DemoTenantSpec = {
	orgName: string;
	/** 出现在模拟台人物选择里。 */
	simulated: boolean;
	people: DemoPersonSpec[];
};

export const DEMO_TENANTS: DemoTenantSpec[] = [
	{
		orgName: "星河科技",
		simulated: true,
		people: [
			{
				handle: "linxiao",
				displayName: "林晓",
				title: "产品负责人",
				status: "busy",
				twinDescription:
					"林晓的分身。林晓忙碌或被点名时，在私聊里替她回答同事关于产品方向、已定排期和预算口径的问题；遇到新的交付承诺或预算调整，整理清楚来龙去脉后转给林晓本人。",
				opsDescription:
					"林晓的执行助手。整理评审纪要、周报和路线图文档，跟踪评审结论里的待办是否按期完成；绑定设备后可在林晓的电脑上归档文档。",
				delegationPolicy:
					"可以回答产品路线和已定排期；承诺新的交付日期、调整预算必须问我；不谈人事。",
				sharedNotes: [
					{
						title: "Q4 路线图",
						body: [
							"目标：10 月 31 日前上线三项。",
							"1. 新版结算页：支持优惠券叠加，10 月 31 日上线。设计陈安，接口周野。",
							"2. 订单服务迁移：10 月 20 日切流；20 日 00:00 至 21 日 12:00 冻结订单相关发布。",
							"3. 商家后台批量改价：后端估 5 人日，排进 11 月第一个迭代。",
							"不在 Q4 范围：会员积分改版、海外站点。",
							"对外口径：以上日期均为已定排期，可以直接答复；任何提前或新增承诺需林晓确认。",
						].join("\n"),
					},
					{
						title: "预算口径：一律不含税",
						body: [
							"对内对外的预算、报价、成本数字一律按不含税口径。",
							"供应商报价如果含税，按 6% 增值税折算后再比较。",
							"Q4 产品线预算 48 万元（不含税），截至 9 月底已用 31.2 万元。",
							"单笔超过 5 万元的支出需要林晓审批。",
						].join("\n"),
					},
					{
						title: "9 月 15 日评审会纪要",
						body: [
							"参会：林晓、周野、陈安、许诺。",
							"结论一：结算页采用方案 B，优惠券在确认页展开，放弃弹窗方案。",
							"结论二：订单服务迁移先切写、后切读，切流日定在 10 月 20 日。",
							"结论三：大客户 A 的定制需求不进 Q4，列入 11 月评估。",
							"待办：陈安 9 月 24 日前交结算页高保真稿；周野 9 月 30 日前完成对账脚本。",
						].join("\n"),
					},
				],
			},
			{
				handle: "zhouye",
				displayName: "周野",
				title: "后端工程师",
				twinDescription:
					"周野的分身。周野忙碌或被点名时替他回答技术方案、接口字段和订单服务迁移的进度，回答时引用迁移进度文档里的数字；涉及排期承诺时转给周野本人。",
				opsDescription:
					"周野的执行助手。查日志、跑对账脚本、整理接口文档；绑定设备后可在周野的开发机上执行命令，写文件和执行命令前先征得周野同意。",
				delegationPolicy: "技术方案和接口进度可以直接答；排期承诺问我。",
				sharedNotes: [
					{
						title: "订单服务迁移进度：完成 70%，预计 10 月 20 日切流",
						body: [
							"已完成：写路径全部切到新库；订单查询、支付回调迁移完毕。",
							"进行中：退款、发票两个查询接口，预计 10 月 10 日完成。",
							"对账：预发环境 12.4 万笔订单差异 38 笔，均为 9 月 3 日前的历史拆单，修复脚本待合入。",
							"计划：10 月 15 日晚跑全量对账（约 6 小时），差异率低于 0.05% 则 10 月 20 日切流。",
							"回滚：读流量切回旧库，5 分钟内完成。",
						].join("\n"),
					},
				],
			},
			{
				handle: "chenan",
				displayName: "陈安",
				title: "设计师",
				twinDescription:
					"陈安的分身。替陈安回答设计规范、组件用法和素材放在哪里，替她和别人的分身约设计评审；新需求的排期转给陈安本人。",
				opsDescription:
					"陈安的执行助手。按规范导出切图、整理 Figma 标注、归档设计素材；绑定设备后可在陈安的电脑上整理素材目录。",
				delegationPolicy: "设计规范和素材位置可以直接答；新需求排期问我。",
				sharedNotes: [
					{
						title: "设计规范 v3 要点",
						body: [
							"主色只用品牌绿，辅助色不超过两种；需要提醒用户时用琥珀色，红色只表示出错。",
							"圆角：卡片 16px，按钮胶囊形，输入框 8px。",
							"字号阶梯 12 / 14 / 16 / 20 / 28，正文 14px。",
							"图标统一 1.5px 线性描边，不混用面性图标。",
							"素材位置：Figma「设计规范 v3」文件，组件库在「Components / 2026」页。",
							"切图导出 2x 与 3x PNG；SVG 图标走组件库，不单独导出。",
						].join("\n"),
					},
				],
			},
			{
				handle: "xunuo",
				displayName: "许诺",
				title: "销售",
				twinDescription:
					"许诺的分身。替许诺回答报价区间和客户进展，替她向产品和研发确认交付信息；折扣超过 9 折的要求转给许诺本人。",
				opsDescription:
					"许诺的执行助手。整理客户拜访记录、准备报价单和合同附件；绑定设备后可在许诺的电脑上生成报价文件。",
				delegationPolicy: "报价区间和客户进展可以答；折扣超过 9 折问我。",
				sharedNotes: [
					{
						title: "大客户 A 进展：等待交付日期确认",
						body: [
							"客户：大客户 A，华东连锁零售，门店 320 家。",
							"阶段：POC 已完成，合同金额约 86 万元（不含税），等交付日期确认后签约。",
							"关键诉求：新版结算页 10 月 15 日前上线，赶双十一备货。",
							"报价区间：标准版 72–90 万元；折扣底线 9 折，更低需林晓批准。",
							"下一步：拿到产品侧的交付日期后，10 月 8 日前给客户正式答复。",
						].join("\n"),
					},
				],
			},
		],
	},
	{
		orgName: "别家公司",
		simulated: false,
		people: [
			{
				handle: "waibu",
				displayName: "魏博",
				title: "采购经理",
				twinDescription:
					"魏博的分身。替魏博回答供应商的询价和交期问题，超出采购预算的事转给魏博本人。",
				opsDescription: "魏博的执行助手。整理采购单、供应商资质和比价表。",
				delegationPolicy: "可以介绍采购流程和到货时间；价格与合同条款问我。",
				sharedNotes: [
					{
						title: "供应商准入流程",
						body: [
							"新供应商需提供营业执照、近一年完税证明和两家客户案例。",
							"准入审核 5 个工作日，审核通过后才能下采购单。",
							"单笔采购超过 20 万元需要两家以上比价。",
						].join("\n"),
					},
				],
			},
		],
	},
];

export function demoEmail(handle: string): string {
	return `${handle}@orgos.local`;
}

export function findDemoPerson(handle: string): DemoPersonSpec | undefined {
	for (const t of DEMO_TENANTS) {
		const p = t.people.find((x) => x.handle === handle);
		if (p) return p;
	}
	return undefined;
}
