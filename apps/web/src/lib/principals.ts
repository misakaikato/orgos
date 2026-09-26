/**
 * 主体相关的显示逻辑：名字、"替谁说话"、头像色、会话标题与侧栏分组。
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
export function ownerOf(p: Principal, map: PrincipalMap): Principal | null {
	return p.ownerId ? (map.get(p.ownerId) ?? null) : null;
}

/** 代理消息顶部的标签：`林晓的幕僚长 · 代林晓`。 */
export function agentByline(p: Principal, map: PrincipalMap): string {
	const owner = ownerOf(p, map);
	return owner ? `${p.displayName} · 代${owner.displayName}` : p.displayName;
}

/** 人的头像底色：按 handle 哈希取 6 个预设之一（返回 1–6）。 */
export function avatarTone(handle: string): number {
	let h = 0;
	for (const ch of handle) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
	return (h % 6) + 1;
}

/** 头像里的一个字：显示名的首字。 */
export function initialOf(name: string): string {
	return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
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
	return othersOf(item, meId)[0]?.displayName ?? "私聊";
}

/** 私聊的对方；群聊为 null。 */
export function dmPeer(
	item: ConversationSummary,
	meId: string,
): Principal | null {
	if (item.conversation.kind !== "dm") return null;
	return othersOf(item, meId)[0] ?? null;
}

export type ListGroups = {
	agents: ConversationSummary[];
	colleagues: ConversationSummary[];
	negotiations: ConversationSummary[];
};

/**
 * 侧栏分组：只含我自己代理的会话 → 我的代理组；协商会话 → 协商；其余 → 同事。
 */
export function groupConversations(
	items: readonly ConversationSummary[],
	meId: string,
): ListGroups {
	const groups: ListGroups = { agents: [], colleagues: [], negotiations: [] };
	for (const item of items) {
		if (item.conversation.kind === "negotiation") {
			groups.negotiations.push(item);
			continue;
		}
		const others = othersOf(item, meId);
		const onlyMyAgents =
			others.length > 0 &&
			others.every((p) => p.kind === "agent" && p.ownerId === meId);
		(onlyMyAgents ? groups.agents : groups.colleagues).push(item);
	}
	return groups;
}
