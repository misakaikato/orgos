/**
 * 主体相关的显示逻辑：名字、"替谁说话"、头像与团子外形、会话标题、列表筛选。
 */
import type {
	ConversationSummary,
	MeResponse,
	Principal,
} from "@orgos/protocol";
import type { Person } from "@/lib/store";

export type PrincipalMap = ReadonlyMap<string, Principal>;

/** 由本人、通讯录与会话成员汇总出已知主体。 */
export function buildPrincipalMap(
	me: MeResponse | null,
	directory: readonly Person[],
	conversations: readonly ConversationSummary[],
): PrincipalMap {
	const map = new Map<string, Principal>();
	for (const item of conversations)
		for (const p of item.members) map.set(p.id, p);
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

/** 各人的对外代表（幕僚长）id：我的取自 me.agents，同事的取自通讯录。 */
export function frontAgentIds(
	me: MeResponse | null,
	directory: readonly Person[],
): ReadonlySet<string> {
	const ids = new Set(directory.map((p) => p.front.id));
	for (const a of me?.agents ?? [])
		if (a.role === "front") ids.add(a.principal.id);
	return ids;
}

/** 代理的一句身份说明：`林晓的代理 · 对外代表林晓` / `你的代理 · 组内专员`。 */
export function agentRoleLine(
	p: Principal,
	map: PrincipalMap,
	meId: string,
	fronts: ReadonlySet<string>,
): string {
	const owner = onBehalfLabel(p, map, meId);
	if (!owner) return "代理";
	return fronts.has(p.id)
		? `${owner}的代理 · 对外代表${owner}`
		: `${owner}的代理 · 组内专员`;
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

export type MascotShape = "round" | "pear" | "bean" | "sprout";
export type MascotEyes = "dot" | "smile" | "oval";

export type MascotTraits = {
	shape: MascotShape;
	eyes: MascotEyes;
	blush: boolean;
	/** 团子色 1–8，对应 --mascot-N。 */
	tone: number;
};

const MASCOT_SHAPES: readonly MascotShape[] = [
	"round",
	"pear",
	"bean",
	"sprout",
];
const MASCOT_EYES: readonly MascotEyes[] = ["dot", "smile", "oval"];

/** 团子外形：由代理 id 确定性选取（DESIGN.md §4），各维度取哈希的不同位段。 */
export function mascotTraits(id: string): MascotTraits {
	const h = hashString(id);
	const mix = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
	return {
		shape: MASCOT_SHAPES[h % 4] ?? "round",
		eyes: MASCOT_EYES[(h >>> 8) % 3] ?? "dot",
		blush: (mix >>> 4) % 3 !== 0,
		tone: ((mix >>> 12) % 8) + 1,
	};
}

/** 除我以外的成员。 */
export function othersOf(item: ConversationSummary, meId: string): Principal[] {
	return item.members.filter((m) => m.id !== meId);
}

/** 会话标题：群聊用群名；私聊用对方名字。 */
export function conversationTitle(
	item: ConversationSummary,
	meId: string,
): string {
	if (item.conversation.kind !== "dm")
		return item.conversation.title ?? "未命名群聊";
	return dmPeer(item, meId)?.displayName ?? "私聊";
}

/**
 * 私聊的对方；群聊为 null。找别人幕僚长的私聊里，对方本人是 observer：
 * 提问的人看到的对方是那位幕僚长；本人看到的对方是来提问的人，而不是自己的幕僚长。
 */
export function dmPeer(
	item: ConversationSummary,
	meId: string,
): Principal | null {
	if (item.conversation.kind !== "dm") return null;
	const others = othersOf(item, meId);
	return (
		others.find((p) => p.kind === "agent" && p.ownerId !== meId) ??
		others.find((p) => p.kind === "human") ??
		others[0] ??
		null
	);
}

export type ListFilter = "all" | "agents" | "colleagues";

export type ConversationFacet = {
	/** 归入哪个筛选胶囊（"全部"之外）。 */
	filter: Exclude<ListFilter, "all">;
	/** 行内小标签。 */
	tag: "代理在对外" | "协商" | null;
};

/**
 * 会话列表的筛选与行内标签（DESIGN.md §5）：
 * - 协商会话 → 代理，标"协商"；
 * - 同事找我的代理（我在其中旁听）→ 代理，标"代理在对外"；
 * - 对方或成员里有代理 → 代理；其余 → 同事。
 */
export function conversationFacet(
	item: ConversationSummary,
	meId: string,
): ConversationFacet {
	if (item.conversation.kind === "negotiation")
		return { filter: "agents", tag: "协商" };
	const others = othersOf(item, meId);
	const myAgentOutside =
		item.conversation.kind === "dm" &&
		others.some((p) => p.kind === "agent" && p.ownerId === meId) &&
		others.some((p) => p.kind === "human");
	if (myAgentOutside) return { filter: "agents", tag: "代理在对外" };
	const peer = dmPeer(item, meId);
	if (peer)
		return {
			filter: peer.kind === "agent" ? "agents" : "colleagues",
			tag: null,
		};
	const onlyAgents =
		others.length > 0 && others.every((p) => p.kind === "agent");
	return { filter: onlyAgents ? "agents" : "colleagues", tag: null };
}

/** 列表行与会话头的头像主体：私聊是对方；协商是对方的代理；群聊为 null（用群头像）。 */
export function conversationAvatar(
	item: ConversationSummary,
	meId: string,
): Principal | null {
	if (item.conversation.kind === "negotiation") {
		const agents = item.members.filter((p) => p.kind === "agent");
		return agents.find((p) => p.ownerId !== meId) ?? agents[0] ?? null;
	}
	return dmPeer(item, meId);
}
