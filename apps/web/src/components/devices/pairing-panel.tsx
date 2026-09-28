"use client";

import {
	type CreatePairingCodeResponse,
	DEVICE_NAME_MAX_LENGTH,
	runnerCommands,
} from "@orgos/protocol";
import { useEffect, useRef, useState } from "react";
import { MessageCard } from "@/components/conversation/cards";
import { IconCheck } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";

const DEFAULT_NAME = "我的电脑";
const DEFAULT_WORKSPACE = "~/orgos-workspace";

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function formatLeft(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** 一条可复制的命令：等宽块 + 右上角"复制"。 */
function CommandBlock({ label, command }: { label: string; command: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between gap-2">
				<span className="text-13 font-medium text-ink">{label}</span>
				<button
					type="button"
					onClick={() => {
						void navigator.clipboard
							?.writeText(command)
							.then(() => {
								setCopied(true);
								if (timer.current) clearTimeout(timer.current);
								timer.current = setTimeout(() => setCopied(false), 1500);
							})
							.catch(() => {});
					}}
					className="inline-flex h-6 shrink-0 items-center gap-1 rounded-pill bg-surface-2 px-2 text-12 text-muted transition-colors duration-150 hover:text-ink"
				>
					{copied ? <IconCheck size={14} /> : null}
					{copied ? "已复制" : "复制"}
				</button>
			</div>
			<pre className="overflow-x-auto rounded-row bg-surface-2 px-3 py-2 font-code text-12 whitespace-pre-wrap break-all text-ink">
				{command}
			</pre>
		</div>
	);
}

/**
 * 添加设备：显示一次性配对码（10 分钟倒计时）与在那台电脑上分两步运行的命令（第 1 步配对、第 2 步启动），
 * 并说明装了桌面客户端的电脑登录后自动配对，也可以在客户端 Runner 控制的"高级"里手动填配对码。
 * 设备连上后（列表里出现新的在线设备）提示成功。
 */
export function PairingPanel({ onClose }: { onClose: () => void }) {
	const [pairing, setPairing] = useState<CreatePairingCodeResponse | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState(DEFAULT_NAME);
	const [now, setNow] = useState(() => Date.now());
	const knownIds = useRef<Set<string> | null>(null);
	const runners = useStore((s) => s.runners);

	const generate = async () => {
		setError(null);
		try {
			setPairing(await api.createPairingCode());
			setNow(Date.now());
		} catch (e) {
			setError(e instanceof Error ? e.message : "生成配对码失败");
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: 打开面板时生成一次。
	useEffect(() => {
		knownIds.current = new Set((runners ?? []).map((r) => r.id));
		void generate();
	}, []);

	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);

	const joined = (runners ?? []).find(
		(r) => r.status === "online" && !knownIds.current?.has(r.id),
	);
	const left = pairing ? Date.parse(pairing.expiresAt) - now : 0;
	const expired = pairing !== null && left <= 0;
	const commands = pairing
		? runnerCommands({
				repoDir: pairing.repoDir,
				server: window.location.origin,
				code: pairing.code,
				name: name.trim() || DEFAULT_NAME,
				workspace: DEFAULT_WORKSPACE,
			})
		: null;

	return (
		<MessageCard
			pending={false}
			className="w-full"
			title={joined ? `已连上：${joined.name}` : "添加设备"}
			meta={
				joined || !pairing
					? null
					: expired
						? "已过期"
						: `${formatLeft(left)} 后过期`
			}
			actions={
				joined ? (
					<Button variant="primary" onClick={onClose}>
						完成
					</Button>
				) : (
					<>
						{expired ? (
							<Button variant="primary" onClick={() => void generate()}>
								重新生成
							</Button>
						) : null}
						<Button onClick={onClose}>取消</Button>
					</>
				)
			}
		>
			{joined ? (
				<p>
					“{joined.name}
					”已经在线。到「代理组」把执行助手绑定到它，助手就能在工作目录里读写文件、执行命令；写文件和执行命令会先问你。
				</p>
			) : error ? (
				<p role="alert" className="text-danger">
					{error}
				</p>
			) : !pairing || !commands ? (
				<p className="text-muted">正在生成配对码…</p>
			) : (
				<div className="flex flex-col gap-4">
					<div>
						<p className="text-13 text-muted">
							配对码（一次性，10 分钟内有效）
						</p>
						<p
							className={
								expired
									? "text-20 font-semibold text-muted line-through"
									: "text-20 font-semibold text-ink"
							}
						>
							{pairing.code}
						</p>
					</div>
					<Field
						label="设备名称"
						value={name}
						maxLength={DEVICE_NAME_MAX_LENGTH}
						onChange={(e) => setName(e.target.value)}
					/>
					<p className="text-13 text-muted">
						在那台电脑的终端里分两步运行下面的命令。
					</p>
					<div className="flex flex-col gap-1.5">
						<CommandBlock label="第 1 步：配对" command={commands.pair} />
						<p className="text-12 text-muted">
							只需运行一次。配对码用过即失效，重复运行会提示这台电脑已配对。
						</p>
					</div>
					<div className="flex flex-col gap-1.5">
						<CommandBlock label="第 2 步：启动" command={commands.serve} />
						<p className="text-12 text-muted">
							配对成功后运行，以后每次开机再运行这一条。工作目录是助手唯一能访问的地方，可以换成别的目录。
						</p>
					</div>
					<p className="text-13 text-muted">
						装了桌面客户端的电脑登录后会自动成为你的设备，不需要配对码；这里的命令给只作为
						Runner 使用、没装客户端的电脑。也可以在客户端 Runner
						控制的“高级”里手动填配对码。
					</p>
				</div>
			)}
		</MessageCard>
	);
}
