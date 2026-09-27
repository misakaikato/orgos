/**
 * 模拟台右侧"剧本"：C1–C4 与 R 的推荐操作。每步写明由谁在哪做，`say` 是可复制的话术；
 * `mock` 是假模型下触发同一能力的指令（真实模型直接用 `say`）。人物与事项都取自演示数据。
 */

export type ScriptStep = {
	/** 演示人物的 handle；终端操作为 null。 */
	who: string | null;
	/** 在哪、做什么。 */
	action: string;
	say?: string;
	mock?: string;
};

export type Scene = {
	id: string;
	title: string;
	summary: string;
	/** 功能尚未开放时的说明。 */
	upcoming?: string;
	steps: ScriptStep[];
};

export const SIM_SCRIPT: Scene[] = [
	{
		id: "C1",
		title: "和自己的代理组聊",
		summary: "林晓让幕僚长查资料、记事、分派给执行助理。",
		steps: [
			{
				who: "linxiao",
				action: "在「我的代理组」打开和幕僚长的私聊，发：",
				say: "帮我把 9 月 15 日评审会的三条结论列出来。",
				mock: "#note 评审会",
			},
			{
				who: "linxiao",
				action: "让幕僚长记一件只有自己知道的事：",
				say: "记一下：10 月 12 日上午要和大客户 A 的 CTO 开视频会。",
				mock: "#remember 视频会|10 月 12 日上午和大客户 A 的 CTO 开视频会",
			},
			{
				who: "linxiao",
				action: "把活交给组里的专员：",
				say: "让执行助理把 Q4 路线图整理成一页周报。",
				mock: "#delegate:linxiao-ops 把 Q4 路线图整理成一页周报",
			},
			{
				who: "linxiao",
				action: "在群聊「Q4 发布」里点名幕僚长：",
				say: "@linxiao-chief 把订单服务迁移的最新进度同步到群里。",
			},
		],
	},
	{
		id: "C2",
		title: "和同事直接聊",
		summary: "周野和林晓互发消息，看另一个窗格实时出现。",
		steps: [
			{
				who: "zhouye",
				action: "打开和林晓的私聊，发：",
				say: "修复脚本已经合进去了，15 日晚上的全量对账照常。",
			},
			{
				who: "linxiao",
				action: "在自己的窗格里回复：",
				say: "好，对账跑完把差异率发我。",
			},
			{
				who: "zhouye",
				action: "在群聊「Q4 发布」里发：",
				say: "@chenan 优惠券接口的 stackable 字段已经上预发了，可以对稿了。",
			},
		],
	},
	{
		id: "C3",
		title: "找别人的幕僚长",
		summary: "许诺问林晓的幕僚长，超出授权的问题转到林晓的待办。",
		steps: [
			{
				who: "xunuo",
				action: "在通讯录点林晓那一行的「找其幕僚长」，问：",
				say: "大客户 A 的交付能提前到 10 月 15 日吗？",
				mock: "#escalate 大客户 A 的交付能否提前到 10 月 15 日",
			},
			{
				who: "xunuo",
				action: "问一个共享资料里答得了的问题：",
				say: "Q4 的预算数字是含税还是不含税？",
				mock: "#note 预算",
			},
			{
				who: "xunuo",
				action: "问一个只在林晓私有记忆里的事，幕僚长不应透露：",
				say: "林晓 10 月 8 日有空见客户吗？",
				mock: "#note 出差",
			},
			{
				who: "linxiao",
				action: "在「待我处理」里答复许诺转来的问题：",
				say: "10 月 15 日来不及，最早 10 月 24 日；可以先给大客户 A 开预发环境试用。",
			},
		],
	},
	{
		id: "C4",
		title: "代理之间协商",
		summary: "两位幕僚长替本人约时间，谈妥后双方各自确认。",
		steps: [
			{
				who: "linxiao",
				action: "对自己的幕僚长说：",
				say: "和周野约周四下午半小时，过一下 15 日全量对账的应急预案。",
				mock: "#negotiate:zhouye 约周四下午半小时过对账应急预案",
			},
			{
				who: "zhouye",
				action: "在「协商」分组里看两位幕僚长每一步的提议与回应。",
			},
			{
				who: "zhouye",
				action: "在「待我处理」里确认协商结果；林晓也确认后，两边都显示已定。",
			},
			{
				who: "chenan",
				action:
					"勾选陈安：她和周野的「约结算页 v2 接口评审」已经谈妥，两人的确认待办都还开着。",
			},
		],
	},
	{
		id: "R",
		title: "让代理用自己的电脑",
		summary:
			"把电脑配对成设备，执行助理在上面读文件、跑命令，有风险的先问本人。",
		upcoming: "设备配对上线后可用。",
		steps: [
			{
				who: "linxiao",
				action: "在「设备」页点「添加设备」，拿到配对码。",
			},
			{
				who: null,
				action: "在自己电脑的终端里配对并启动：",
				say: "bun run --cwd apps/runner start pair <配对码> --name 林晓的MacBook",
			},
			{
				who: "linxiao",
				action: "把执行助理绑定到这台设备，然后对执行助理说：",
				say: "列出工作目录里的文件。",
				mock: "#ls .",
			},
			{
				who: "linxiao",
				action: "让它执行命令，会先出现审批卡片，批准后才执行：",
				say: "在工作目录里执行 git status。",
				mock: "#exec git status",
			},
		],
	},
];
