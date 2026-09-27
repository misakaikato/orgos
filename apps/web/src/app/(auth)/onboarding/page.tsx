"use client";

import {
	defaultAssistantHandle,
	HANDLE_RE,
	type OnboardingRequest,
	twinHandle,
} from "@orgos/protocol";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { resetSession } from "@/lib/store";

type Mode = OnboardingRequest["mode"];

const MODES: { mode: Mode; label: string }[] = [
	{ mode: "create", label: "新建组织" },
	{ mode: "join", label: "用邀请码加入" },
];

export default function OnboardingPage() {
	const router = useRouter();
	const [mode, setMode] = useState<Mode>("create");
	const [displayName, setDisplayName] = useState("");
	const [handle, setHandle] = useState("");
	const [orgName, setOrgName] = useState("");
	const [inviteCode, setInviteCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [handleError, setHandleError] = useState<string | null>(null);
	const [codeError, setCodeError] = useState<string | null>(null);

	const handleInvalid = handle.length > 0 && !HANDLE_RE.test(handle);

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);
		setHandleError(null);
		setCodeError(null);
		const extra = mode === "create" ? orgName.trim() : inviteCode.trim();
		if (!displayName.trim() || !handle || !extra) {
			setError("请把每一项都填上");
			return;
		}
		if (!HANDLE_RE.test(handle)) {
			setHandleError("小写字母开头，2–31 位小写字母、数字或连字符");
			return;
		}
		const req: OnboardingRequest =
			mode === "create"
				? { mode, orgName: extra, displayName: displayName.trim(), handle }
				: { mode, inviteCode: extra, displayName: displayName.trim(), handle };
		setBusy(true);
		try {
			await api.onboarding(req);
			resetSession();
			router.replace("/");
		} catch (err) {
			setBusy(false);
			if (!(err instanceof ApiError)) {
				setError("提交失败，请重试");
				return;
			}
			if (err.status === 401) router.replace("/login");
			else if (err.code === "ALREADY_ONBOARDED") router.replace("/");
			else if (err.code === "HANDLE_TAKEN")
				setHandleError("这个 handle 在组织里已被占用");
			else if (err.code === "INVITE_CODE_INVALID") setCodeError("邀请码无效");
			else setError(err.message);
		}
	}

	return (
		<AuthCard
			title="加入组织"
			subtitle="建一个新组织，或用同事给你的邀请码加入。"
			onSubmit={submit}
			error={error}
		>
			<div
				role="tablist"
				aria-label="入驻方式"
				className="flex gap-1 rounded-pill bg-surface-2 p-1"
			>
				{MODES.map((m) => (
					<button
						key={m.mode}
						type="button"
						role="tab"
						aria-selected={mode === m.mode}
						onClick={() => setMode(m.mode)}
						className={cx(
							"h-8 flex-1 rounded-pill text-13 font-medium transition-colors duration-150",
							mode === m.mode
								? "bg-bg text-ink shadow-card-hover"
								: "text-muted hover:text-ink",
						)}
					>
						{m.label}
					</button>
				))}
			</div>
			{mode === "create" ? (
				<Field
					label="组织名称"
					value={orgName}
					onChange={(e) => setOrgName(e.target.value)}
				/>
			) : (
				<Field
					label="邀请码"
					className="[&_input]:uppercase"
					value={inviteCode}
					error={codeError}
					onChange={(e) => setInviteCode(e.target.value)}
				/>
			)}
			<Field
				label="你的名字"
				hint="同事和代理都这样称呼你"
				value={displayName}
				onChange={(e) => setDisplayName(e.target.value)}
			/>
			<Field
				label="Handle"
				autoCapitalize="none"
				spellCheck={false}
				hint={
					handle && !handleInvalid
						? `你的代理：@${twinHandle(handle)}、@${defaultAssistantHandle(handle)}`
						: "小写字母开头，用于 @ 提及"
				}
				error={
					handleError ??
					(handleInvalid ? "只能用小写字母、数字和连字符，字母开头" : null)
				}
				value={handle}
				onChange={(e) => setHandle(e.target.value.trim().toLowerCase())}
			/>
			<Button
				type="submit"
				variant="primary"
				disabled={busy}
				className="mt-2 w-full"
			>
				{busy ? "提交中…" : mode === "create" ? "创建组织" : "加入组织"}
			</Button>
		</AuthCard>
	);
}
