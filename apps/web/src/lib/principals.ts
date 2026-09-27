/**
 * 主体相关的显示逻辑：名字、"替谁说话"、头像与团子外形、会话标题、列表筛选。
 */
import {
	AGENT_ROLE_LABEL,
	type ConversationSummary,
	type MeResponse,
	type OrgUnit,
	type Principal,
	type PrincipalStatus,
} from "@orgos/protocol";
import type { Person } from "@/lib/store";

export type PrincipalMap = ReadonlyMap<string, Principal>;

/** 由本人、通讯录、组织结构与会话成员汇总出已知主体（单元与单元分身来自组织结构）。 */
export function buildPrincipalMap(
	me: MeResponse | null,
	directory: readonly Person[],
	conversations: readonly ConversationSummary[],
	org: readonly OrgUnit[] = [],
): PrincipalMap {
	const map = new Map<string, Principal>();
	for (const item of conversations)
		for (const p of item.members) map.set(p.id, p);
	for (const u of org) {
		map.set(u.unit.id, u.unit);
		map.set(u.twin.id, u.twin);
	}
	for (const person of directory) {
		map.set(person.principal.id, person.principal);
		map.set(person.front.id, person.front);
	}
	if (me) {
		map.set(me.principal.id, me.principal);
		for (const a of me.agents) map.set(a.principal.id, a.principal);
	}
	return map;
}

export function isAgent(p: Principal): boolean {
	return p.kind === "agent";
}

/** 代理的本人（找不到时为 null）。 */
export function ownerOf(
	p: Pick<Principal, "ownerId">,
	map: PrincipalMap,
): Principal | null {
	return p.ownerId ? (map.get(p.ownerId) ?? null) : null;
}

/** 代理的"代谁"：本人是我时为"你"。 */
export function onBehalfLabel(
	p: Pick<Principal, "ownerId">,
	map: PrincipalMap,
	meId: string,
): string | null {
	const owner = ownerOf(p, map);
	if (!owner) return null;
	return owner.id === meId ? "你" : owner.displayName;
}

/** 各人与各单元的分身 id：我的取自 me.agents，同事的取自通讯录，单元的取自组织结构。 */
export function frontAgentIds(
	me: MeResponse | null,
	directory: readonly Person[],
	org: readonly OrgUnit[] = [],
): ReadonlySet<string> {
	const ids = new Set([
		...directory.map((p) => p.front.id),
		...org.map((u) => u.twin.id),
	]);
	for (const a of me?.agents ?? [])
		if (a.role === "front") ids.add(a.principal.id);
	return ids;
}

/** 代理的一句身份说明：`林晓的分身 · 对外代表林晓` / `你的助手 · 只替你办事`。 */
export function agentRoleLine(
	p: Principal,
	map: PrincipalMap,
	meId: string,
	fronts: ReadonlySet<string>,
): string {
	const owner = onBehalfLabel(p, map, meId);
	if (!owner) return "代理";
	return fronts.has(p.id)
		? `${owner}的${AGENT_ROLE_LABEL.front} · 对外代表${owner}`
		: `${owner}的${AGENT_ROLE_LABEL.specialist} · 只替${owner}办事`;
}

export const STATUS_LABEL: Record<PrincipalStatus, string> = {
	available: "在线",
	busy: "忙碌",
	away: "离开",
};

/** 真人私聊输入框上方的提示；对方在线时为 null。 */
export function unavailableHint(
	p: Pick<Principal, "displayName" | "status">,
): string | null {
	if (p.status === "busy") return `${p.displayName}正在忙，分身会先回复你`;
	if (p.status === "away") return `${p.displayName}暂时离开，分身会先回复你`;
	return null;
}

/** 人的头像底色：按 handle 哈希取 6 个预设之一（返回 1–6）。 */
export function avatarTone(handle: string): number {
	return (hashString(handle) % 6) + 1;
}

/**
 * 人的头像文字：中文名取最后两个字（"林晓""周野"）；
 * 拉丁字母名取各词首字母大写（最多两个，"Alice Wang" → "AW"）。
 */
export function avatarText(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "?";
	if (/^[\x20-\x7e]+$/.test(trimmed)) {
		const words = trimmed.split(/[\s._-]+/).filter(Boolean);
		return words
			.slice(0, 2)
			.map((w) => w[0]?.toUpperCase() ?? "")
			.join("");
	}
	return Array.from(trimmed.replace(/\s+/g, "")).slice(-2).join("");
}

/** FNV-1a 32 位哈希：同一字符串永远得到同一个值。 */
export function hashString(s: string): number {
	let h = 0x811c9dc5;
	for (const ch of s) {
		h ^= ch.codePointAt(0) ?? 0;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

/** 团子插画：12 张图各自的名字色（--mascot-N / --mascot-N-ink 的 N）。图与色的唯一对应表。 */
const MASCOT_ART_TONES = [1, 2, 3, 5, 6, 7, 4, 8, 1, 2, 4, 5] as const;

export const MASCOT_ART_COUNT = MASCOT_ART_TONES.length;

export type MascotArt = {
	/** 插画序号 1–12，对应 public/mascots/mNN.png。 */
	index: number;
	src: string;
	/** 团子色 1–8。 */
	tone: number;
};

/** 第 index 张团子插画（1 起）。 */
export function mascotArtAt(index: number): MascotArt {
	return {
		index,
		src: `/mascots/m${String(index).padStart(2, "0")}.png`,
		tone: MASCOT_ART_TONES[index - 1] ?? 1,
	};
}

/** 代理的团子：由 id 哈希确定性选取 12 张插画之一（DESIGN.md §4）。 */
export function mascotArt(id: string): MascotArt {
	return mascotArtAt((hashString(id) % MASCOT_ART_COUNT) + 1);
}

/** 除我以外的成员。 */
export function othersOf(item: ConversationSummary, meId: string): Principal[] {
	return item.members.filter((m) => m.id !== meId);
}

/** 会话标题：群聊用群名；私聊用对方名字（真人私聊里是对方本人，分身不占标题）。 */
export function conversationTitle(
	item: ConversationSummary,
	meId: string,
): string {
	if (item.conversation.kind !== "dm")
		return item.conversation.title ?? "未命名群聊";
	return dmPeer(item, meId)?.displayName ?? "私聊";
}

/** 私聊的对方：真人私聊里是对方本人；和自己代理的私聊里是那个代理。群聊为 null。 */
export function dmPeer(
	item: ConversationSummary,
	meId: string,
): Principal | null {
	if (item.conversation.kind !== "dm") return null;
	const others = othersOf(item, meId);
	return others.find((p) => p.kind === "human") ?? others[0] ?? null;
}

/**
 * 两个真人的私聊（含双方分身）：返回对方本人与双方分身；其他会话为 null。
 * 私聊里的代理都是双方的分身，按主人区分。
 */
export function humanPair(
	item: ConversationSummary,
	meId: string,
): {
	peer: Principal;
	peerTwin: Principal | null;
	myTwin: Principal | null;
} | null {
	if (item.conversation.kind !== "dm") return null;
	const humans = item.members.filter((p) => p.kind === "human");
	const peer = humans.find((p) => p.id !== meId);
	if (humans.length !== 2 || !peer || !humans.some((p) => p.id === meId))
		return null;
	const twinOf = (ownerId: string) =>
		item.members.find((p) => p.kind === "agent" && p.ownerId === ownerId) ??
		null;
	return { peer, peerTwin: twinOf(peer.id), myTwin: twinOf(meId) };
}

export type ListFilter = "all" | "agents" | "colleagues";

/**
 * 会话列表的筛选归属（DESIGN.md §5）：和自己代理的私聊、只有代理的群 → 代理；
 * 真人私聊（分身只是陪同）与有同事的群 → 同事。
 */
export function conversationFilter(
	item: ConversationSummary,
	meId: string,
): Exclude<ListFilter, "all"> {
	const peer = dmPeer(item, meId);
	if (peer) return peer.kind === "agent" ? "agents" : "colleagues";
	const others = othersOf(item, meId);
	return others.length > 0 && others.every((p) => p.kind === "agent")
		? "agents"
		: "colleagues";
}

/** 列表行与会话头的头像主体：私聊是对方；群聊为 null（用群头像）。 */
export function conversationAvatar(
	item: ConversationSummary,
	meId: string,
): Principal | null {
	return dmPeer(item, meId);
}
