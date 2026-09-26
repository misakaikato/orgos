"use client";

import type { ConversationSummary, Principal } from "@orgos/protocol";
import { useState } from "react";
import { IconClose, IconPlus } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button, IconButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { ownerOf, type PrincipalMap } from "@/lib/principals";
import { addMember, useStore } from "@/lib/store";

function roleLabel(p: Principal, map: PrincipalMap, meId: string): string {
	if (p.id === meId) return "你";
	if (p.kind === "human") return "人";
	const owner = ownerOf(p, map);
	return owner
		? `代理 · 代${owner.id === meId ? "你" : owner.displayName}`
		: "代理";
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
}: {
	p: Principal;
	map: PrincipalMap;
	meId: string;
}) {
	return (
		<li className="flex items-center gap-3 px-4 py-2">
			<Avatar principal={p} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-14 text-ink">{p.displayName}</span>
				<span className="truncate font-code text-12 text-muted">
					@{p.handle}
				</span>
			</span>
			<span className="shrink-0 text-12 text-muted">
				{roleLabel(p, map, meId)}
			</span>
		</li>
	);
}

/** 可拉进群的人：同事、同事的幕僚长、我自己的代理（他人的专员不可达）。 */
function useCandidates(exclude: ReadonlySet<string>): Principal[] {
	const me = useStore((s) => s.me);
	const directory = useStore((s) => s.directory);
	if (!me) return [];
	const list: Principal[] = [];
	for (const person of directory) {
		if (person.principal.id !== me.principal.id)
			list.push(person.principal, person.front);
	}
	for (const a of me.agents) list.push(a.principal);
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
				<h3 className="text-12 font-medium text-muted">添加成员</h3>
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
				<EmptyState
					compact
					text="能拉进来的人都已经在群里了。"
					action={{ label: "收起", onClick: onDone }}
				/>
			) : (
				<ul>
					{candidates.map((p) => (
						<li key={p.id} className="flex items-center gap-3 px-4 py-2">
							<Avatar principal={p} size="sm" />
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

/** 检查器：会话成员；群聊可以加人。 */
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
	const memberIds = new Set(item.members.map((m) => m.id));
	const isGroup = item.conversation.kind === "group";
	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
				<h2 className="text-14 font-medium text-ink">
					成员{" "}
					<span className="font-code text-12 tabular-nums text-muted">
						{item.members.length}
					</span>
				</h2>
				<IconButton label="关闭检查器" onClick={onClose}>
					<IconClose size={18} />
				</IconButton>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<ul className="py-2">
					{sortMembers(item.members, meId).map((p) => (
						<MemberRow key={p.id} p={p} map={map} meId={meId} />
					))}
				</ul>
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
