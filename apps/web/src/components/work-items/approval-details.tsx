import { approvalDetails } from "@/lib/device";

/** 审批的完整参数：路径作正文，命令与写入内容放等宽块。设备名与能力由标题给出。 */
export function ApprovalDetails({
	capability,
	args,
}: {
	capability: string;
	args: unknown;
}) {
	const { path, code } = approvalDetails(capability, args);
	return (
		<div className="mt-2 flex flex-col gap-2">
			{path !== undefined ? (
				<p className="text-14 break-all text-ink">{path || "."}</p>
			) : null}
			{code !== undefined ? (
				<pre className="max-h-64 overflow-auto rounded-row bg-surface-2 px-3 py-2 font-code text-12 whitespace-pre-wrap break-all text-ink">
					{code || "（空）"}
				</pre>
			) : null}
		</div>
	);
}
