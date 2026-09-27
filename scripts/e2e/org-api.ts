/**
 * 指挥分身操作软件（应用接口工具）与组织结构（单元、单元分身、单元群、问部门、部门协商）。
 */
import {
	ConversationListResponseSchema,
	type Event,
	OrgResponseSchema,
	type OrgUnit,
	OrgUnitResponseSchema,
	UnitDetailResponseSchema,
} from "@orgos/protocol";
import {
	check,
	equal,
	eventAfter,
	events,
	excludes,
	expectError,
	expectStatus,
	includes,
	type Member,
	messagesBy,
	openDm,
	openItem,
	openItems,
	post,
	replyFrom,
	resolveItem,
	type Scenario,
	settle,
} from "./kit";
import { negotiate } from "./twin";

type ActionEvent = Extract<Event, { type: "agent.action" }>;

async function conversationsOf(m: Member) {
	const body = await expectStatus(
		`读 ${m.name} 的会话列表`,
		await m.client.request("GET", "/api/conversations"),
		200,
	);
	return ConversationListResponseSchema.parse(body).items;
}

export const appApi: Scenario = {
	name: "指挥分身操作软件",
	async run(w, step) {
		const { alice, bob, carol } = w;
		/** bob 在私聊里让 alice 的分身调接口，返回这次调用的动作与分身的回复。 */
		const bobAsks = async (command: string) => {
			const asked = await post(bob.client, w.ids.pairDm, command, {
				askTwin: true,
			});
			const reply = await replyFrom(
				bob.client,
				w.ids.pairDm,
				alice.twin,
				asked.id,
			);
			const action = (await events(bob.client, w.ids.pairDm)).find(
				(e): e is ActionEvent =>
					e.type === "agent.action" &&
					e.id > asked.id &&
					e.actorId === alice.twin.id,
			);
			return { action, reply: reply.payload.text };
		};

		await step(
			"为本人建群：群建成，建群事件的 actor 是分身、onBehalfOf 是 alice",
			async () => {
				const body = {
					kind: "group",
					title: "结算页联调",
					memberIds: [bob.id, carol.id],
				};
				const asked = await post(
					alice.client,
					w.ids.aliceTwinDm,
					`#api POST /api/conversations ${JSON.stringify(body)}`,
				);
				const reply = await replyFrom(
					alice.client,
					w.ids.aliceTwinDm,
					alice.twin,
					asked.id,
				);
				check(
					"分身的回复",
					reply.payload.text.startsWith("完成：HTTP 201"),
					"以“完成：HTTP 201”开头",
					reply.payload.text,
				);
				const group = (await conversationsOf(bob)).find(
					(i) => i.conversation.title === "结算页联调",
				);
				check("bob 的列表里有新群", !!group, "有", undefined);
				const members = new Set(group?.members.map((m) => m.id));
				for (const id of [
					alice.id,
					bob.id,
					carol.id,
					alice.twin.id,
					bob.twin.id,
					carol.twin.id,
				])
					check("群成员", members.has(id), `含 ${id}`, [...members]);
				const joined = (
					await events(bob.client, group?.conversation.id ?? "")
				).filter((e) => e.type === "member.joined");
				check("member.joined", joined.length > 0, "≥1 条", 0);
				for (const e of joined)
					equal(
						"member.joined 的 actor / onBehalfOf",
						[e.actorId, e.onBehalfOfId],
						[alice.twin.id, alice.id],
					);
			},
		);
		await step("为他人：调 private_read 的接口被拒，提示改为上报", async () => {
			const { action, reply } = await bobAsks("#api GET /api/work-items");
			equal("动作", action && [action.payload.tool, action.payload.ok], [
				"app_api_call",
				false,
			]);
			includes("分身的回复", reply, "无权限");
		});
		await step("为他人：建不含提问人的群被拒，群没有建出来", async () => {
			const body = { kind: "group", title: "无提问人", memberIds: [carol.id] };
			const { action } = await bobAsks(
				`#api POST /api/conversations ${JSON.stringify(body)}`,
			);
			equal("动作是否成功", action?.payload.ok, false);
			const made = (await conversationsOf(alice)).some(
				(i) => i.conversation.title === "无提问人",
			);
			equal("alice 的列表里有“无提问人”", made, false);
		});
	},
};

async function createUnit(
	m: Member,
	body: { name: string; handle: string; headId: string },
): Promise<OrgUnit> {
	const res = await expectStatus(
		`建单元“${body.name}”`,
		await m.client.request("POST", "/api/org/units", body),
		201,
	);
	return OrgUnitResponseSchema.parse(res).unit;
}

export const org: Scenario = {
	name: "组织结构",
	async run(w, step) {
		const { alice, bob, carol, dave } = w;
		let product: OrgUnit | undefined;
		let rd: OrgUnit | undefined;
		const unit = () => {
			if (!product || !rd) throw new Error("单元还没建");
			return {
				product,
				rd,
				twin: { id: product.twin.id, handle: product.twin.handle },
			};
		};
		let bobDm = "";
		let carolDm = "";

		await step(
			"租户 owner 建产品部（负责人 alice，成员 carol）：自动出现“产品部的分身”与“产品部”群",
			async () => {
				product = await createUnit(alice, {
					name: "产品部",
					handle: "product",
					headId: alice.id,
				});
				await expectStatus(
					"加成员 carol",
					await alice.client.request(
						"POST",
						`/api/org/units/${product.unit.id}/members`,
						{
							principalId: carol.id,
						},
					),
					201,
				);
				await expectStatus(
					"写章程",
					await alice.client.request(
						"PATCH",
						`/api/org/units/${product.unit.id}`,
						{
							charter: "排期按路线图直接答复；插队需求问负责人。",
						},
					),
					200,
				);
				rd = await createUnit(alice, {
					name: "研发部",
					handle: "rd",
					headId: bob.id,
				});
				equal("单元分身", product.twin.displayName, "产品部的分身");
				const group = (await conversationsOf(carol)).find(
					(i) => i.conversation.id === product?.groupId,
				);
				equal("单元群标题", group?.conversation.title, "产品部");
				const ids = new Set(group?.members.map((m) => m.id));
				for (const id of [product.twin.id, alice.id, carol.id])
					check("单元群成员", ids.has(id), `含 ${id}`, [...ids]);
			},
		);
		await step("非租户 owner 建单元 → 403；别的租户看不到单元", async () => {
			await expectError(
				"bob 建单元",
				await bob.client.request("POST", "/api/org/units", {
					name: "销售部",
					handle: "sales",
					headId: bob.id,
				}),
				403,
			);
			const seen = OrgResponseSchema.parse(
				await expectStatus(
					"dave 读组织",
					await dave.client.request("GET", "/api/org"),
					200,
				),
			).units.map((u) => u.unit.id);
			excludes("dave 的组织树", JSON.stringify(seen), unit().product.unit.id);
			await expectError(
				"dave 读产品部",
				await dave.client.request(
					"GET",
					`/api/org/units/${unit().product.unit.id}`,
				),
				404,
			);
		});
		await step(
			"问部门：非成员 bob 只检索到 shared 资料，成员 carol 还能检索到 unit 级",
			async () => {
				const { product: p, twin } = unit();
				for (const note of [
					{
						title: "路线图（对外）",
						body: "结算页 10 月 31 日上线",
						visibility: "shared",
					},
					{
						title: "路线图（内部）",
						body: "结算页走查由成员负责",
						visibility: "unit",
					},
				])
					await expectStatus(
						`carol 写单元资料“${note.title}”`,
						await carol.client.request(
							"POST",
							`/api/org/units/${p.unit.id}/notes`,
							note,
						),
						201,
					);
				bobDm = await openDm(bob.client, twin.id);
				carolDm = await openDm(carol.client, twin.id);
				const toBob = await post(bob.client, bobDm, "#note 路线图");
				const r1 = (await replyFrom(bob.client, bobDm, twin, toBob.id)).payload
					.text;
				includes("给 bob 的回复", r1, "路线图（对外）");
				excludes("给 bob 的回复", r1, "路线图（内部）");
				const toCarol = await post(carol.client, carolDm, "#note 路线图");
				const r2 = (await replyFrom(carol.client, carolDm, twin, toCarol.id))
					.payload.text;
				includes("给 carol 的回复", r2, "路线图（内部）");
			},
		);
		await step(
			"章程外上报负责人：alice 有 decision，答复后分身在 bob 的私聊里转告",
			async () => {
				const { twin } = unit();
				await post(bob.client, bobDm, "#escalate 能否插队需求 X");
				const item = await openItem(
					"alice 的 decision 待办",
					alice,
					(x) =>
						x.kind === "decision" &&
						x.requesterId === bob.id &&
						x.conversationId === bobDm,
				);
				const last = (await events(bob.client, bobDm)).at(-1)?.id ?? 0;
				await resolveItem(alice, item.id, {
					action: "answer",
					text: "不能插队，排到 11 月",
				});
				const reply = await replyFrom(bob.client, bobDm, twin, last);
				equal(
					"分身的回复",
					reply.payload.text,
					"本人答复：不能插队，排到 11 月",
				);
			},
		);
		await step(
			"record_decision：单元资料多一条 visibility=unit、作者是单元分身，列在单元页的最近决定里",
			async () => {
				const { product: p, twin } = unit();
				const asked = await post(
					bob.client,
					bobDm,
					"#decide 灰度比例定为 10%|结算页按 10% 灰度",
				);
				await replyFrom(bob.client, bobDm, twin, asked.id);
				const detail = UnitDetailResponseSchema.parse(
					await expectStatus(
						"carol 读单元页",
						await carol.client.request("GET", `/api/org/units/${p.unit.id}`),
						200,
					),
				);
				const decision = detail.decisions.find(
					(n) => n.title === "灰度比例定为 10%",
				);
				equal(
					"单元页“最近决定”里的这条资料",
					decision && [decision.visibility, decision.authorId],
					["unit", twin.id],
				);
			},
		);
		await step("单元分身不在任何两人私聊的成员里", async () => {
			const { product: p, rd: r } = unit();
			for (const m of [alice, bob, carol])
				for (const item of await conversationsOf(m)) {
					const humans = item.members.filter((x) => x.kind === "human");
					if (item.conversation.kind !== "dm" || humans.length !== 2) continue;
					const ids = item.members.map((x) => x.id);
					check(
						"两人私聊的成员",
						!ids.includes(p.twin.id) && !ids.includes(r.twin.id),
						"不含单元分身",
						ids,
					);
				}
		});
		await step(
			"部门之间协商：产品部与研发部的分身谈妥，确认待办给两位负责人",
			async () => {
				const { ended, id } = await negotiate(
					{ m: carol, dm: carolDm },
					"#negotiate:rd 约联调时间",
					{ m: alice, dm: w.ids.pairDm },
				);
				equal("结果", ended.payload.outcome, "agreed");
				const steps = (await events(alice.client, id)).filter(
					(e) => e.type === "negotiation.step",
				);
				const speakers = new Set(steps.map((e) => e.actorId));
				equal(
					"出面的分身",
					[...speakers].sort(),
					[unit().product.twin.id, unit().rd.twin.id].sort(),
				);
				for (const m of [alice, bob]) {
					const mine = (await openItems(m)).filter(
						(x) =>
							x.kind === "confirmation" &&
							(x.payload as { negotiationConversationId?: string })
								.negotiationConversationId === id,
					);
					equal(`${m.name} 的确认待办`, mine.length, 1);
				}
			},
		);
		await step(
			"部门协商里的 need_owner 交给对应的负责人（研发部 → bob）",
			async () => {
				const { rd: r } = unit();
				const { ended } = await negotiate(
					{ m: carol, dm: carolDm },
					"#negotiate:rd 约评审 #needowner",
					{ m: alice, dm: w.ids.pairDm },
					async () => {
						const card = await eventAfter(
							"研发部分身的上报卡片",
							bob.client,
							w.ids.pairDm,
							0,
							(e): e is Extract<Event, { type: "escalation.created" }> =>
								e.type === "escalation.created" && e.actorId === r.twin.id,
						);
						const item = await openItem(
							"bob 的 decision 待办",
							bob,
							(x) => x.id === card.payload.workItemId,
						);
						await resolveItem(bob, item.id, { action: "answer", text: "可以" });
					},
				);
				equal("结果", ended.payload.outcome, "agreed");
				const all = await settle(w, carol.client, carolDm);
				check(
					"carol 的私聊里有协商结果",
					messagesBy(all, unit().twin.id).length > 0,
					"有",
					0,
				);
			},
		);
	},
};
