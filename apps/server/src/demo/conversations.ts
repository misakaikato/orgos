/**
 * 星河科技的预置会话。时间按"重置时刻往前推"回放，seq 顺序与时间顺序一致；
 * 已读位置按"这个人大概看到哪了"设置，让每个窗格一打开就有该看的新消息。
 */
import type { Event } from "@orgos/protocol";
import type { PrincipalRow } from "@/db/scope";
import type { DemoCast } from "@/demo/seed";
import { postAgentMessage, recordAgentAction } from "@/services/agent-events";
import {
	createGroup,
	markRead,
	openDm,
	postMessage,
} from "@/services/conversations";
import {
	appendNegotiationStep,
	endNegotiation,
	startNegotiation,
} from "@/services/negotiations";
import { createNote } from "@/services/notes";
import { createTopic, mainTopicOf } from "@/services/topics";
import { escalateToOwner } from "@/services/work-items";

function seqOf(event: Event): number {
	if (event.seq === null) throw new Error("会话事件缺少 seq");
	return event.seq;
}

/** 星河科技在北京时间办公（UTC+8，无夏令时），与服务进程的时区无关。 */
const OFFICE_UTC_OFFSET_HOURS = 8;

type Clock = {
	/** 北京时间 `daysAgo` 天前的 hh:mm。 */
	day(daysAgo: number, hhmm: string): Date;
	minutesAgo(n: number): Date;
};

function clockAt(now: Date): Clock {
	const office = new Date(now.getTime() + OFFICE_UTC_OFFSET_HOURS * 3_600_000);
	return {
		day(daysAgo, hhmm) {
			const [h = 0, m = 0] = hhmm.split(":").map(Number);
			return new Date(
				Date.UTC(
					office.getUTCFullYear(),
					office.getUTCMonth(),
					office.getUTCDate() - daysAgo,
					h - OFFICE_UTC_OFFSET_HOURS,
					m,
				),
			);
		},
		minutesAgo(n) {
			return new Date(now.getTime() - n * 60_000);
		},
	};
}

export async function writeDemoConversations(
	cast: DemoCast,
	now: Date,
): Promise<void> {
	const { s } = cast;
	const t = clockAt(now);
	const say = (who: PrincipalRow, id: string, text: string, at: Date) =>
		postMessage(s, who, id, { text }, at);
	const agentSays = (
		agent: PrincipalRow,
		id: string,
		text: string,
		at: Date,
		topicId?: string,
	) =>
		postAgentMessage(
			s,
			agent.id,
			{ conversationId: id, ...(topicId ? { topicId } : {}) },
			text,
			{ at },
		);
	const readUpTo = (who: PrincipalRow, id: string, seq: number) =>
		markRead(s, who, id, seq);

	const linxiao = cast.human("linxiao");
	const zhouye = cast.human("zhouye");
	const chenan = cast.human("chenan");
	const xunuo = cast.human("xunuo");

	// ── 群聊"Q4 发布"：林晓、周野、陈安（各自的分身随本人在群里） ──
	const { conversation: q4 } = await createGroup(
		s,
		linxiao,
		"Q4 发布",
		[zhouye.id, chenan.id],
		{ at: t.day(3, "09:26") },
	);
	await say(
		linxiao,
		q4.id,
		"Q4 发布的范围定了：新版结算页、订单服务迁移、商家后台批量改价，10 月 31 日前全部上线。细节在我共享的《Q4 路线图》里，有出入的地方直接在群里说。",
		t.day(3, "09:30"),
	);
	await postMessage(
		s,
		chenan,
		q4.id,
		{
			text: "结算页高保真稿周三给到，这次把优惠券叠加的三种状态都画出来了。@zhouye 接口字段如果有变，提前跟我说一声。",
			mentions: [zhouye.id],
		},
		t.day(3, "09:48"),
	);
	await say(
		zhouye,
		q4.id,
		"优惠券接口会多一个 stackable 字段，其余不变。批量改价我粗估了一下，后端 5 个人日，11 月第一个迭代能排进去。",
		t.day(3, "10:05"),
	);
	const twinL = cast.twin("linxiao");
	await postMessage(
		s,
		linxiao,
		q4.id,
		{
			text: `@${twinL.handle} 把这周的进展整理成一段，周五我发给管理层。`,
			mentions: [twinL.id],
		},
		t.day(2, "16:20"),
	);
	await recordAgentAction(
		s,
		twinL.id,
		{ conversationId: q4.id },
		{
			tool: "knowledge_search",
			summary: "查阅了《Q4 路线图》和《9 月 15 日评审会纪要》",
			ok: true,
		},
		t.day(2, "16:21"),
	);
	await agentSays(
		twinL,
		q4.id,
		[
			"本周进展：",
			"1. 新版结算页：高保真稿已交付，覆盖优惠券叠加的三种状态；接口新增 stackable 字段。",
			"2. 订单服务迁移：完成约 70%，计划 10 月 20 日切流，20 日 00:00 至 21 日 12:00 冻结订单相关发布。",
			"3. 商家后台批量改价：后端评估 5 人日，排进 11 月第一个迭代。",
			"风险：切流取决于 10 月 15 日的全量对账结果。你确认后我再发出。",
		].join("\n"),
		t.day(2, "16:22"),
	);
	const q4Last = await say(
		chenan,
		q4.id,
		"稿子放在 Figma「Q4 / 结算页 v2」里了，标注已经切好，评论区可以直接提。",
		t.day(1, "15:30"),
	);
	await readUpTo(linxiao, q4.id, seqOf(q4Last));
	await readUpTo(chenan, q4.id, seqOf(q4Last));
	await readUpTo(zhouye, q4.id, seqOf(q4Last) - 1);

	// ── 林晓 ↔ 周野：订单服务迁移切流（私聊含双方分身，分身没有发言） ──
	const { conversation: dmLZ } = await openDm(s, zhouye, linxiao.id);
	const lz: [PrincipalRow, string, Date][] = [
		[
			zhouye,
			"同步一下订单服务迁移：写路径已经全部切到新库，读路径还剩退款和发票两个查询没迁，整体大概 70%。",
			t.day(2, "14:05"),
		],
		[
			linxiao,
			"10 月 20 日切流还稳吗？市场那边 22 日要发秋季活动，我不想两件事挤在同一周。",
			t.day(2, "14:09"),
		],
		[
			zhouye,
			"20 日本身没问题，风险在双写对账。上周对账差异率 0.3%，主要是优惠券拆单的金额四舍五入不一致。",
			t.day(2, "14:16"),
		],
		[
			zhouye,
			"修完要再跑一轮全量对账才敢切，一轮大概 6 小时，我打算 15 日晚上跑。",
			t.day(2, "14:17"),
		],
		[
			linxiao,
			"切流当天要不要冻结发布？需要的话我去跟陈安说，结算页的上线往后挪两天。",
			t.day(2, "14:25"),
		],
		[
			zhouye,
			"要。20 日 00:00 到 21 日 12:00 冻结订单相关的发布就够，其他服务不受影响。回滚就是把读流量切回旧库，5 分钟内能完成。",
			t.day(2, "14:31"),
		],
		[
			linxiao,
			"好，冻结窗口我写进路线图了。15 日对账结果出来第一时间告诉我，差异率超过 0.05% 我们就重新评估日期。",
			t.day(1, "10:02"),
		],
		[
			zhouye,
			"收到。对账脚本今天先在预发跑一遍，下午把结果发你。",
			t.day(1, "10:40"),
		],
		[
			zhouye,
			"预发跑完了：12.4 万笔订单，差异 38 笔，全部是 9 月 3 日之前的历史拆单。修复脚本写好了，周一合进去。",
			t.day(1, "17:12"),
		],
	];
	let lzLast = 0;
	for (const [who, text, at] of lz) {
		lzLast = seqOf(await say(who, dmLZ.id, text, at));
	}
	await readUpTo(zhouye, dmLZ.id, lzLast);
	await readUpTo(linxiao, dmLZ.id, lzLast - 1);

	// ── 林晓 ↔ 自己的分身：一条私有记忆 ──
	const { conversation: dmLC } = await openDm(s, linxiao, twinL.id);
	await say(
		linxiao,
		dmLC.id,
		"记一下：我 10 月 8 日到 10 日在杭州出差，这几天的会都往后排，别替我答应任何线下会议。",
		t.day(4, "20:10"),
	);
	await createNote(s, {
		ownerId: linxiao.id,
		authorId: twinL.id,
		title: "10 月 8–10 日杭州出差",
		body: "期间的会议邀请一律回复对方改期，不替林晓答应线下会议。",
		visibility: "private",
	});
	await recordAgentAction(
		s,
		twinL.id,
		{ conversationId: dmLC.id },
		{ tool: "memory_save", summary: "记下：10 月 8–10 日杭州出差", ok: true },
		t.day(4, "20:10"),
	);
	await agentSays(
		twinL,
		dmLC.id,
		"记下了。10 月 8 日到 10 日你在杭州，期间的会议邀请我先回复对方改期，不替你答应线下会议。这条是私有记忆，只有你和我能看到。",
		t.day(4, "20:11"),
	);
	await say(
		linxiao,
		dmLC.id,
		"大客户 A 那边如果有人来问交付日期，按路线图答 10 月 31 日，别松口提前。",
		t.day(1, "21:05"),
	);
	const lcLast = await agentSays(
		twinL,
		dmLC.id,
		"明白。有人问大客户 A 的交付日期，我按《Q4 路线图》答 10 月 31 日；对方要求提前的话，我转给你本人决定。",
		t.day(1, "21:05"),
	);
	await readUpTo(linxiao, dmLC.id, seqOf(lcLast));

	// ── 林晓 ↔ 执行助手：主线之外另开了一个话题"周五管理层周报" ──
	const opsL = cast.ops("linxiao");
	const { conversation: dmLO } = await openDm(s, linxiao, opsL.id);
	await say(
		linxiao,
		dmLO.id,
		"以后每周一上午帮我把上周的待办过一遍，没关的列出来。",
		t.day(3, "09:05"),
	);
	await agentSays(
		opsL,
		dmLO.id,
		"好的，每周一上午 10 点前我把上周没关的待办整理成清单发给你。",
		t.day(3, "09:05"),
	);
	const weekly = await createTopic(s, linxiao, dmLO.id, "周五管理层周报");
	await postMessage(
		s,
		linxiao,
		dmLO.id,
		{
			text: "周五的管理层周报先按上周的格式起个草稿，重点写切流风险和冻结窗口。",
			topicId: weekly.id,
		},
		t.day(1, "18:40"),
	);
	const weeklyLast = await agentSays(
		opsL,
		dmLO.id,
		"草稿起好了：一、Q4 三项进展；二、切流风险（15 日全量对账决定是否按期）；三、10 月 20 日 00:00 至 21 日 12:00 冻结订单相关发布。你看完告诉我要不要加预算口径。",
		t.day(1, "18:42"),
		weekly.id,
	);
	await readUpTo(linxiao, dmLO.id, seqOf(weeklyLast) - 1);

	// ── 许诺 ↔ 林晓：林晓忙碌，她的分身替她答复并把超出授权的问题转给她 ──
	const { conversation: dmXL } = await openDm(s, xunuo, linxiao.id);
	await say(
		xunuo,
		dmXL.id,
		"林晓，大客户 A 下周要拿到正式的交付日期，我这边先把报价单按 86 万准备着。",
		t.day(2, "11:02"),
	);
	await say(
		linxiao,
		dmXL.id,
		"可以，报价按不含税口径写。交付日期以路线图为准，有变化我第一时间告诉你。",
		t.day(2, "11:15"),
	);
	const asked = await say(
		xunuo,
		dmXL.id,
		"大客户 A 这周又来催了，他们希望 10 月 15 日前用上新版结算页，好赶双十一备货。交付能提前到 10 月 15 日吗？",
		t.minutesAgo(96),
	);
	await recordAgentAction(
		s,
		twinL.id,
		{ conversationId: dmXL.id },
		{ tool: "knowledge_search", summary: "查阅了《Q4 路线图》", ok: true },
		t.minutesAgo(95),
	);
	await agentSays(
		twinL,
		dmXL.id,
		"林晓正在忙，我是她的分身，先替她回复。根据她共享的《Q4 路线图》，新版结算页排在 10 月 31 日前上线，目前没有提前的计划。提前到 10 月 15 日属于新的交付承诺，超出我的授权，我已经转给林晓本人，她答复后我第一时间告诉你。",
		t.minutesAgo(95),
	);
	await escalateToOwner(s, {
		agentId: twinL.id,
		conversationId: dmXL.id,
		topicId: (await mainTopicOf(s, dmXL.id)).id,
		requesterId: xunuo.id,
		title: "许诺问：大客户 A 的新版结算页能否提前到 10 月 15 日交付",
		question:
			"大客户 A 希望 10 月 15 日前用上新版结算页（路线图为 10 月 31 日），好赶双十一备货。能否提前？",
		sourceEventId: asked.id,
		at: t.minutesAgo(95),
	});
	const xlLast = await say(
		xunuo,
		dmXL.id,
		"好，那我先跟客户说 10 月 8 日前给正式答复。",
		t.minutesAgo(92),
	);
	await readUpTo(xunuo, dmXL.id, seqOf(xlLast));
	await readUpTo(linxiao, dmXL.id, seqOf(asked) - 1);

	// ── 陈安让分身约周野评审；两位分身协商已谈妥，卡片在陈安 ↔ 周野的私聊里，等双方确认 ──
	const chenanTwin = cast.twin("chenan");
	const zhouyeTwin = cast.twin("zhouye");
	const { conversation: dmCZ } = await openDm(s, chenan, zhouye.id);
	await say(
		chenan,
		dmCZ.id,
		"周野，结算页 v2 的接口字段想找你当面过一遍，我让分身和你的分身约个时间。",
		t.day(1, "11:18"),
	);
	const { conversation: dmCC } = await openDm(s, chenan, chenanTwin.id);
	const ccAsked = await say(
		chenan,
		dmCC.id,
		"帮我和周野约一个小时，评审结算页 v2 的接口字段，下周一到周三都行，最好别占他上午。",
		t.day(1, "11:20"),
	);
	await recordAgentAction(
		s,
		chenanTwin.id,
		{ conversationId: dmCC.id },
		{
			tool: "negotiate",
			summary: "已发起与周野的代理协商：约结算页 v2 接口评审",
			ok: true,
		},
		t.day(1, "11:20"),
	);
	const nego = await startNegotiation(s, {
		initiatorAgentId: chenanTwin.id,
		responderAgentId: zhouyeTwin.id,
		goal: "和周野约一小时，评审结算页 v2 的接口字段，下周一到周三",
		title: "约结算页 v2 接口评审",
		at: t.day(1, "11:20"),
	});
	const firstSlot = {
		slot: "9 月 29 日（周二）14:00",
		duration: "60 分钟",
		topic: "结算页 v2 接口字段评审",
	};
	const agreedSlot = { ...firstSlot, slot: "9 月 30 日（周三）15:30" };
	await appendNegotiationStep(
		s,
		nego.id,
		chenanTwin.id,
		{
			status: "continue",
			message:
				"陈安想约一小时评审结算页 v2 的接口字段，周一到周三的下午都可以。先提议周二 14:00。",
			proposal: firstSlot,
		},
		t.day(1, "11:21"),
	);
	await appendNegotiationStep(
		s,
		nego.id,
		zhouyeTwin.id,
		{
			status: "continue",
			message:
				"周二下午周野要做对账复盘，时间冲突。周三 15:00 以后他都空着，改到周三 15:30 可以吗？",
			proposal: agreedSlot,
		},
		t.day(1, "11:21"),
	);
	await appendNegotiationStep(
		s,
		nego.id,
		chenanTwin.id,
		{
			status: "agree",
			message: "周三 15:30 可以，陈安那天下午没有别的安排。",
			proposal: agreedSlot,
		},
		t.day(1, "11:22"),
	);
	await endNegotiation(s, nego.id, "agreed", t.day(1, "11:22"));
	await agentSays(
		chenanTwin,
		dmCC.id,
		"和周野的分身谈妥了：9 月 30 日（周三）15:30，一小时，评审结算页 v2 的接口字段。周二下午他有对账复盘，所以没选周二。等你和周野都确认后就算定下来。",
		t.day(1, "11:23"),
	);
	await readUpTo(chenan, dmCC.id, seqOf(ccAsked));
}
