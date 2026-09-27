"use client";

import {
	askUnitLabel,
	type OrgUnit,
	UNIT_MEMBER_ROLE_LABEL,
} from "@orgos/protocol";
import Link from "next/link";
import { Avatar, GroupAvatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appHref } from "@/lib/auth-mode";
import { cx } from "@/lib/cx";

type Node = { unit: OrgUnit; children: Node[] };

/** 单元行按层级缩进；更深的层级与第三层对齐（组织树通常不超过三层）。 */
const UNIT_INDENT = ["pl-4", "pl-10", "pl-16"] as const;
/** 成员行缩进到所属单元名字的起点（头像 40 + 间距 12）。 */
const MEMBER_INDENT = ["pl-16", "pl-24", "pl-28"] as const;

/** 按 parentId 组成树；上级不在列表里的当作顶层。 */
export function buildOrgTree(units: readonly OrgUnit[]): Node[] {
	const ids = new Set(units.map((u) => u.unit.id));
	const childrenOf = (parentId: string | null): Node[] =>
		units
			.filter((u) =>
				parentId === null
					? u.parentId === null || !ids.has(u.parentId)
					: u.parentId === parentId,
			)
			.map((u) => ({ unit: u, children: childrenOf(u.unit.id) }));
	return childrenOf(null);
}

function UnitRow({
	node,
	depth,
	meId,
	pendingId,
	onAsk,
}: {
	node: Node;
	depth: number;
	meId: string;
	pendingId: string | null;
	onAsk: (twinId: string) => void;
}) {
	const { unit } = node;
	const name = unit.unit.displayName;
	const busy = pendingId === unit.twin.id;
	return (
		<>
			<li
				className={cx(
					"flex items-center gap-3 py-3 pr-4",
					UNIT_INDENT[Math.min(depth, 2)],
				)}
			>
				<Link
					href={appHref(`/units/${unit.unit.id}`)}
					className="flex min-w-0 flex-1 items-center gap-3 rounded-row hover:opacity-80"
				>
					<GroupAvatar id={unit.unit.id} title={name} size={40} />
					<span className="flex min-w-0 flex-col">
						<span className="truncate text-14 font-semibold text-ink">
							{name}
						</span>
						<span className="truncate text-12 text-muted">
							负责人 {unit.head.displayName} · {unit.members.length} 人
						</span>
					</span>
				</Link>
				<Button disabled={busy} onClick={() => onAsk(unit.twin.id)}>
					{busy ? "打开中…" : askUnitLabel(name)}
				</Button>
			</li>
			{unit.members.map((m) => (
				<li
					key={m.principal.id}
					className={cx(
						"flex items-center gap-3 py-2 pr-4",
						MEMBER_INDENT[Math.min(depth, 2)],
					)}
				>
					<Avatar principal={m.principal} size={32} showStatus />
					<span className="min-w-0 flex-1 truncate text-14 text-ink">
						{m.principal.displayName}
						{m.principal.id === meId ? (
							<span className="ml-1 text-12 text-muted">（你）</span>
						) : null}
					</span>
					{m.role === "head" ? <Tag>{UNIT_MEMBER_ROLE_LABEL.head}</Tag> : null}
				</li>
			))}
			{node.children.map((child) => (
				<UnitRow
					key={child.unit.unit.id}
					node={child}
					depth={depth + 1}
					meId={meId}
					pendingId={pendingId}
					onAsk={onAsk}
				/>
			))}
		</>
	);
}

/** 通讯录顶部的组织树：单元 → 成员；每个单元行有"问<单元名>"，打开与单元分身的私聊。 */
export function OrgTree({
	units,
	meId,
	pendingId,
	onAsk,
}: {
	units: readonly OrgUnit[];
	meId: string;
	pendingId: string | null;
	onAsk: (twinId: string) => void;
}) {
	return (
		<ul className="divide-y divide-line">
			{buildOrgTree(units).map((node) => (
				<UnitRow
					key={node.unit.unit.id}
					node={node}
					depth={0}
					meId={meId}
					pendingId={pendingId}
					onAsk={onAsk}
				/>
			))}
		</ul>
	);
}
