"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api";
import { resetSession } from "@/lib/store";

const MIN_PASSWORD = 8;

export default function RegisterPage() {
	const router = useRouter();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!name.trim() || !email.trim()) {
			setError("请填写名字和邮箱");
			return;
		}
		if (password.length < MIN_PASSWORD) {
			setError(`密码至少 ${MIN_PASSWORD} 位`);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.signUp(name.trim(), email.trim(), password);
			await api.signIn(email.trim(), password);
			resetSession();
			router.replace("/onboarding");
		} catch (err) {
			setError(
				err instanceof ApiError && err.status === 422
					? "这个邮箱已经注册过了"
					: err instanceof Error
						? err.message
						: "注册失败",
			);
			setBusy(false);
		}
	}

	return (
		<AuthCard
			title="注册"
			subtitle="注册后会自动为你配好两个代理：幕僚长与执行助理。"
			onSubmit={submit}
			error={error}
			footer={
				<>
					已有账号？{" "}
					<Link
						href="/login"
						className="font-medium text-accent hover:underline"
					>
						登录
					</Link>
				</>
			}
		>
			<Field
				label="名字"
				autoComplete="name"
				value={name}
				onChange={(e) => setName(e.target.value)}
				autoFocus
			/>
			<Field
				label="邮箱"
				type="email"
				autoComplete="email"
				value={email}
				onChange={(e) => setEmail(e.target.value)}
			/>
			<Field
				label="密码"
				type="password"
				autoComplete="new-password"
				hint={`至少 ${MIN_PASSWORD} 位`}
				value={password}
				onChange={(e) => setPassword(e.target.value)}
			/>
			<Button
				type="submit"
				variant="primary"
				disabled={busy}
				className="mt-2 w-full"
			>
				{busy ? "注册中…" : "注册"}
			</Button>
		</AuthCard>
	);
}
