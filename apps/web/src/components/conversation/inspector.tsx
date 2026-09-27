"use client";

import type { ConversationSummary, Principal } from "@orgos/protocol";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AgentName } from "@/components/conversation/message-item";
import { IconClose, IconPlus } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button, IconButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { appHref } from "@/lib/auth-mode";
import {
	agentRoleLine,
	conversationAvatar,
	frontAgentIds,
	humanPair,
	type PrincipalMap,
	STATUS_LABEL,
} from "@/lib/principals";
import { addMember, removeMember, useStore } from "@/lib/store";

function useFronts(): ReadonlySet<string> {
	const me = useStore((s) => s.me);
	const directory = useStore((s) => s.directory);
	const org = useStore((s) => s.org);
	return frontAgentIds(me, directory, org);
}

/** 人的副标题：@handle，不在线时带状态。 */
function personLine(p: Principal): string {
	return p.status && p.status !== "available"
		? `@${p.handle} · ${STATUS_LABEL[p.status]}`
		: `@${p.handle}`;
}

/** 我在最前，其后是人，再后是代理；同类按显示名。 */
function sortMembers(members: readonly Principal[], meId: string): Principal[] {
	const rank = (p: Principal) =>
		p.id === meId ? 0 : p.kind === "human" ? 1 : 2;
	return [...members].sort(
		(a, b) =>
			rank(a) - rank(b) || a.displayName.localeCompare(b.displayName, "zh-CN"),
	);
}

function MemberRow({
	p,
	map,
	meId,
	fronts,
	onRemove,
}: {
	p: Principal;
	map: PrincipalMap;
	meId: string;
	fronts: ReadonlySet<string>;
	/** 给了则行尾有"移出"（自己是"退出"）。 */
	onRemove?: () => Promise<void>;
}) {
	const current = map.get(p.id) ?? p;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<li className="flex items-center gap-3 px-4 py-2">
			<Avatar principal={current} size={40} showStatus />
			<span className="flex min-w-0 flex-1 flex-col">
				{p.kind === "agent" ? (
					<AgentName agent={p} map={map} meId={meId} />
				) : (
					<span className="truncate text-14 font-medium text-ink">
						{p.displayName}
						{p.id === meId ? (
							<span className="ml-1.5 text-12 font-normal text-muted">你</span>
						) : null}
					</span>
				)}
				<span className="truncate text-12 text-muted">
					{error ??
						(p.kind === "agent"
							? agentRoleLine(p, map, meId, fronts)
							: personLine(current))}
				</span>
			</span>
			{onRemove ? (
				<Button
					variant="danger"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						setError(null);
						try {
							await onRemove();
						} catch (e) {
							setError(e instanceof Error ? e.message : "操作失败");
							setBusy(false);
						}
					}}
				>
					{p.id === meId ? "退出" : "移出"}
				</Button>
			) : null}
		</li>
	);
}

/** 私聊对象的名片：72px 头像或团子、名字、身份说明。 */
function Profile({
	p,
	map,
	meId,
	fronts,
}: {
	p: Principal;
	map: PrincipalMap;
	meId: string;
	fronts: ReadonlySet<string>;
}) {
	const current = map.get(p.id) ?? p;
	return (
		<div className="flex flex-col items-center gap-2 border-b border-line px-4 pt-6 pb-5 text-center">
			<Avatar principal={current} size={72} showStatus />
			<p className="mt-1 text-16 font-semibold text-ink">{p.displayName}</p>
			<p className="text-12 text-muted">
				{p.kind === "agent"
					? agentRoleLine(p, map, meId, fronts)
					: personLine(current)}
			</p>
		</div>
	);
}

/** 可拉进群的：同事（分身随本人入群）与我自己的内置助手（我的分身随我在群里、外部助手不进群）。 */
function useCandidates(exclude: ReadonlySet<string>): Principal[] {
	const me = useStore((s) => s.me);
	const directory = useStore((s) => s.directory);
	if (!me) return [];
	const list: Principal[] = [];
	for (const person of directory)
		if (person.principal.id !== me.principal.id) list.push(person.principal);
	for (const a of me.agents)
		if (a.role !== "front" && a.engine !== "acp") list.push(a.principal);
	return list.filter((p) => !exclude.has(p.id));
}

function AddMemberPanel({
	conversationId,
	memberIds,
	onDone,
}: {
	conversationId: string;
	memberIds: ReadonlySet<string>;
	onDone: () => void;
}) {
	const candidates = useCandidates(memberIds);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	return (
		<div className="border-t border-line py-2">
			<div className="flex items-center justify-between px-4 py-1">
				<h3 className="text-13 font-semibold text-ink">添加成员</h3>
				<IconButton label="收起" onClick={onDone}>
					<IconClose size={16} />
				</IconButton>
			</div>
			{error ? (
				<p role="alert" className="px-4 text-12 text-danger">
					{error}
				</p>
			) : null}
			{candidates.length === 0 ? (
				<EmptyState compact text="能拉进来的人都已经在群里了。" />
			) : (
				<ul>
					{candidates.map((p) => (
						<li key={p.id} className="flex items-center gap-3 px-4 py-2">
							<Avatar principal={p} size={32} />
							<span className="min-w-0 flex-1 truncate text-14 text-ink">
								{p.displayName}
							</span>
							<Button
								disabled={pending !== null}
								onClick={async () => {
									setPending(p.id);
									setError(null);
									try {
										await addMember(conversationId, p.id);
									} catch (e) {
										setError(e instanceof Error ? e.message : "添加失败");
									} finally {
										setPending(null);
									}
								}}
							>
								{pending === p.id ? "添加中…" : "添加"}
							</Button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * 检查器：私聊对象的名片、会话成员（只列人）、群里的助手与分身各一栏；
 * 群聊可以加人（分身随本人入群）、退群与移出。
 */
export function Inspector({
	item,
	map,
	meId,
	onClose,
}: {
	item: ConversationSummary;
	map: PrincipalMap;
	meId: string;
	onClose: () => void;
}) {
	const [adding, setAdding] = useState(false);
	const router = useRouter();
	const fronts = useFronts();
	const profile =
		item.conversation.kind === "dm" ? conversationAvatar(item, meId) : null;
	const memberIds = new Set(item.members.map((m) => m.id));
	const isGroup = item.conversation.kind === "group";
	const pair = humanPair(item, meId);
	const people =
		pair || isGroup
			? item.members.filter((p) => p.kind === "human")
			: item.members;
	const twins = pair
		? [pair.peerTwin, pair.myTwin].filter((p): p is Principal => p !== null)
		: isGroup
			? item.members.filter((p) => p.kind === "agent" && fronts.has(p.id))
			: [];
	const helpers = isGroup
		? item.members.filter((p) => p.kind === "agent" && !fronts.has(p.id))
		: [];
	const creator = item.conversation.createdBy === meId;
	const removable = (p: Principal) =>
		isGroup &&
		(p.id === meId ||
			(p.kind === "agent" && p.ownerId === meId) ||
			(creator && p.kind === "human"));
	const remove = (p: Principal) => async () => {
		await removeMember(item.conversation.id, p.id);
		if (p.id === meId) router.push(appHref("/"));
	};
	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex h-header shrink-0 items-center justify-between gap-2 border-b border-line px-4">
				<h2 className="text-16 font-semibold text-ink">会话信息</h2>
				<IconButton label="关闭检查器" onClick={onClose}>
					<IconClose size={18} />
				</IconButton>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{profile ? (
					<Profile p={profile} map={map} meId={meId} fronts={fronts} />
				) : null}
				<h3 className="px-4 pt-4 pb-1 text-13 font-semibold text-ink">
					成员 <span className="font-normal text-muted">{people.length}</span>
				</h3>
				<ul className="pb-2">
					{sortMembers(people, meId).map((p) => (
						<MemberRow
							key={p.id}
							p={p}
							map={map}
							meId={meId}
							fronts={fronts}
							onRemove={removable(p) ? remove(p) : undefined}
						/>
					))}
				</ul>
				{helpers.length > 0 ? (
					<>
						<h3 className="px-4 pt-2 pb-1 text-13 font-semibold text-ink">
							助手{" "}
							<span className="font-normal text-muted">{helpers.length}</span>
						</h3>
						<ul className="pb-2">
							{helpers.map((p) => (
								<MemberRow
									key={p.id}
									p={p}
									map={map}
									meId={meId}
									fronts={fronts}
									onRemove={removable(p) ? remove(p) : undefined}
								/>
							))}
						</ul>
					</>
				) : null}
				{twins.length > 0 ? (
					<>
						<h3 className="px-4 pt-2 pb-1 text-13 font-semibold text-ink">
							分身{" "}
							<span className="font-normal text-muted">{twins.length}</span>
						</h3>
						<p className="px-4 pb-1 text-12 text-muted">
							{isGroup
								? "随本人入群、退群；平时不开口，被点名或本人忙碌时替本人回答。"
								: "平时不开口；被点名、切到“问分身”或本人忙碌时替本人回答。"}
						</p>
						<ul className="pb-2">
							{twins.map((p) => (
								<MemberRow
									key={p.id}
									p={p}
									map={map}
									meId={meId}
									fronts={fronts}
								/>
							))}
						</ul>
					</>
				) : null}
				{isGroup && !adding ? (
					<div className="px-4 pb-4">
						<Button onClick={() => setAdding(true)}>
							<IconPlus size={16} />
							添加成员
						</Button>
					</div>
				) : null}
				{isGroup && adding ? (
					<AddMemberPanel
						conversationId={item.conversation.id}
						memberIds={memberIds}
						onDone={() => setAdding(false)}
					/>
				) : null}
			</div>
		</div>
	);
}
