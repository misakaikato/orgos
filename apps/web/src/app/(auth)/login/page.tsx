"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { api } from "@/lib/api";
import { resetSession } from "@/lib/store";

export default function LoginPage() {
	const router = useRouter();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!email.trim() || !password) {
			setError("请填写邮箱和密码");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.signIn(email.trim(), password);
			resetSession();
			router.replace("/");
		} catch {
			setError("邮箱或密码不对");
			setBusy(false);
		}
	}

	return (
		<AuthCard
			title="登录"
			subtitle="回到你和代理组的工作台。"
			onSubmit={submit}
			error={error}
			footer={
				<>
					还没有账号？{" "}
					<Link
						href="/register"
						className="font-medium text-accent hover:underline"
					>
						注册
					</Link>
				</>
			}
		>
			<Field
				label="邮箱"
				type="email"
				autoComplete="email"
				value={email}
				onChange={(e) => setEmail(e.target.value)}
				autoFocus
			/>
			<Field
				label="密码"
				type="password"
				autoComplete="current-password"
				value={password}
				onChange={(e) => setPassword(e.target.value)}
			/>
			<Button
				type="submit"
				variant="primary"
				disabled={busy}
				className="mt-2 w-full"
			>
				{busy ? "登录中…" : "登录"}
			</Button>
		</AuthCard>
	);
}
