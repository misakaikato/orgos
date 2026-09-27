/**
 * 模拟台右侧"剧本"：C1–C6、话题与任务、R 的推荐操作。每步写明由谁在哪做，`say` 是可复制的话术；
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
				action:
					"把活交给执行助手（它会在你和执行助手的私聊里新开一个任务话题，结果发在那里）：",
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
		id: "C5",
		title: "问部门",
		summary:
			"许诺去问产品部：章程内的排期问题部门分身直接答，插队需求转给负责人林晓，答复后分身在原私聊转告。",
		steps: [
			{
				who: "xunuo",
				action: "在「通讯录」顶部的组织树里点产品部的「问产品部」，发：",
				say: "新版结算页什么时候上线？",
				mock: "#note 路线图",
			},
			{
				who: "xunuo",
				action: "再问一个章程之外的（新需求插队），分身应转给林晓：",
				say: "大客户 A 要求插队加一个导出功能，能排进 10 月吗？",
				mock: "#escalate 大客户 A 要求插队加导出功能，能否排进 10 月",
			},
			{
				who: "linxiao",
				action: "在「待办」里答复产品部分身转来的问题：",
				say: "10 月排不进，11 月第一个迭代评估；可以先用现有的对账单导出应急。",
			},
			{
				who: "xunuo",
				action: "回到与产品部分身的私聊，看它转告林晓的答复。",
			},
			{
				who: "linxiao",
				action:
					"点组织树里的「产品部」进单元页：看章程、单元资料和分身最近的决定；负责人还能看单元记忆与代答记录。",
			},
		],
	},
	{
		id: "C6",
		title: "部门之间协商",
		summary:
			"销售部的分身替许诺去和研发部的分身约联调时间；许诺与周野的私聊里出现协商卡片，谈妥后两位负责人各自确认。",
		steps: [
			{
				who: "xunuo",
				action: "在组织树里点「问销售部」，对销售部的分身说：",
				say: "和研发部约一次大客户 A 结算页演示前的联调，下周二到周四下午，一小时。",
				mock: "#negotiate:rd 约大客户 A 演示前的联调，一小时",
			},
			{
				who: "zhouye",
				action:
					"打开和许诺的私聊：协商卡片显示两个部门分身的步数，点「查看过程」看提议与回应。",
			},
			{
				who: "zhouye",
				action: "谈妥后在卡片或「待办」里确认；许诺也确认后两边都显示已定。",
			},
		],
	},
	{
		id: "T",
		title: "话题与任务",
		summary:
			"一个代理只有一个私聊，另起一件事就开个话题；话题可以转为任务、转成群聊。",
		steps: [
			{
				who: "linxiao",
				action:
					"打开和执行助手的私聊：左侧话题栏里除了主线，还有一个「周五管理层周报」话题。点「＋新话题」建一个「预算口径核对」，在里面发：",
				say: "把 Q4 各项目报价里含税和不含税的写法对一遍，列出不一致的地方。",
			},
			{
				who: "linxiao",
				action:
					"点话题标题栏的「转为任务」：话题顶部出现任务状态条，话题栏里带上状态点。再发一句让它接着干：",
				say: "顺便把统一口径的建议写在最后。",
			},
			{
				who: "linxiao",
				action:
					"满意了就在状态条上点「完成」：状态点变成已完成，话题照样可以接着聊。",
			},
			{
				who: "linxiao",
				action:
					"回到「周五管理层周报」话题，点「转成群聊」，拉上周野：新群的开头可以展开这个话题的历史，原话题标记已转出。",
			},
			{
				who: "linxiao",
				action:
					"在群聊「Q4 发布」的检查器里看：成员只列人，三位的分身单列在「分身」一栏；添加许诺后，她的分身也随她入群。",
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
