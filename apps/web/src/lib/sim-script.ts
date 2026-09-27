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
	steps: ScriptStep[];
};

export const SIM_SCRIPT: Scene[] = [
	{
		id: "C1",
		title: "和自己的代理组聊",
		summary: "林晓让分身查资料、记事、把活交给执行助手。",
		steps: [
			{
				who: "linxiao",
				action: "在「我的代理组」打开和分身的私聊，发：",
				say: "帮我把 9 月 15 日评审会的三条结论列出来。",
				mock: "#note 评审会",
			},
			{
				who: "linxiao",
				action: "让分身记一件只有自己知道的事：",
				say: "记一下：10 月 12 日上午要和大客户 A 的 CTO 开视频会。",
				mock: "#remember 视频会|10 月 12 日上午和大客户 A 的 CTO 开视频会",
			},
			{
				who: "linxiao",
				action: "把活交给执行助手：",
				say: "让执行助手把 Q4 路线图整理成一页周报。",
				mock: "#delegate:linxiao-ops 把 Q4 路线图整理成一页周报",
			},
			{
				who: "linxiao",
				action: "在群聊「Q4 发布」里点名分身：",
				say: "@linxiao-twin 把订单服务迁移的最新进度同步到群里。",
			},
		],
	},
	{
		id: "C2",
		title: "和同事直接聊",
		summary: "周野和林晓互发消息，看另一个窗格实时出现；分身在私聊里不开口。",
		steps: [
			{
				who: "zhouye",
				action: "打开和林晓的私聊，「发给林晓」状态下发：",
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
		title: "让同事的分身先回答",
		summary:
			"许诺在和林晓的私聊里问事：林晓忙碌时分身直接替她答，超出授权的转到林晓的待办。",
		steps: [
			{
				who: "xunuo",
				action:
					"打开和林晓的私聊（输入框上方提示林晓正在忙），直接发——分身会先回复：",
				say: "大客户 A 的交付能提前到 10 月 15 日吗？",
				mock: "#escalate 大客户 A 的交付能否提前到 10 月 15 日",
			},
			{
				who: "xunuo",
				action:
					"把输入框左侧的开关切到「问林晓的分身」，问一个共享资料里答得了的：",
				say: "Q4 的预算数字是含税还是不含税？",
				mock: "#note 预算",
			},
			{
				who: "xunuo",
				action: "再切「问分身」，问一个只在林晓私有记忆里的事，分身不应透露：",
				say: "林晓 10 月 8 日有空见客户吗？",
				mock: "#note 出差",
			},
			{
				who: "linxiao",
				action: "在「待办」或私聊里的卡片上答复许诺转来的问题：",
				say: "10 月 15 日来不及，最早 10 月 24 日；可以先给大客户 A 开预发环境试用。",
			},
			{
				who: "linxiao",
				action:
					"在头像菜单把状态切回「在线」，之后许诺直接发的消息只到林晓本人。",
			},
		],
	},
	{
		id: "C4",
		title: "分身之间协商",
		summary:
			"两位分身替本人约时间；两人私聊里出现协商卡片，谈妥后双方各自确认。",
		steps: [
			{
				who: "linxiao",
				action: "对自己的分身说：",
				say: "和周野约周四下午半小时，过一下 15 日全量对账的应急预案。",
				mock: "#negotiate:zhouye 约周四下午半小时过对账应急预案",
			},
			{
				who: "zhouye",
				action:
					"打开和林晓的私聊，看协商卡片的步数与状态，点「查看过程」看每一步的提议与回应。",
			},
			{
				who: "zhouye",
				action:
					"在卡片或「待办」里确认协商结果；林晓也确认后，两边都显示已定。",
			},
			{
				who: "chenan",
				action:
					"勾选陈安：她和周野的私聊里有一张已谈妥的「结算页 v2 接口评审」协商卡片，两人的确认待办都还开着。",
			},
		],
	},
	{
		id: "R",
		title: "让代理用自己的电脑",
		summary:
			"把电脑配对成设备，执行助手在上面读文件、跑命令，有风险的先问本人。",
		steps: [
			{
				who: "linxiao",
				action:
					"在「设备」页点「添加设备」，拿到配对码和两条命令（10 分钟内有效）。",
			},
			{
				who: null,
				action: "在本机终端里（仓库目录下）先配对：",
				say: "bun run --cwd apps/runner start pair <配对码> --server http://localhost:8930 --name 林晓的MacBook",
			},
			{
				who: null,
				action: "再启动 Runner，工作目录是助手唯一能访问的地方：",
				say: "bun run --cwd apps/runner start serve --workspace ~/orgos-workspace",
			},
			{
				who: "linxiao",
				action: "在「代理组」把执行助手绑定到这台设备，然后对执行助手说：",
				say: "列出工作目录里的文件。",
				mock: "#ls .",
			},
			{
				who: "linxiao",
				action: "让它执行命令：先出现审批卡片，点「允许」后才执行：",
				say: "在工作目录里执行 echo hello。",
				mock: "#exec echo hello",
			},
			{
				who: "linxiao",
				action: "再让它执行一条命令，这次在审批卡片上点「拒绝」：",
				say: "把工作目录里的 todo.txt 删掉。",
				mock: "#exec rm todo.txt",
			},
		],
	},
];
