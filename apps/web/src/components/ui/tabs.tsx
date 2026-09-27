import { cx } from "@/lib/cx";

/** 页内分段标签（代理组页、单元页）：胶囊底，选中项白底。 */
export function Tabs<K extends string>({
	tabs,
	tab,
	onChange,
	label,
}: {
	tabs: readonly { key: K; label: string }[];
	tab: K;
	onChange: (t: K) => void;
	label: string;
}) {
	return (
		<div
			role="tablist"
			aria-label={label}
			className="flex w-full max-w-lg gap-1 rounded-pill bg-surface-2 p-1"
		>
			{tabs.map((t) => (
				<button
					key={t.key}
					type="button"
					role="tab"
					aria-selected={tab === t.key}
					onClick={() => onChange(t.key)}
					className={cx(
						"inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-pill px-1 text-13 whitespace-nowrap transition-colors duration-150",
						tab === t.key
							? "bg-bg font-medium text-ink shadow-card-hover"
							: "text-muted hover:text-ink",
					)}
				>
					{t.label}
				</button>
			))}
		</div>
	);
}
