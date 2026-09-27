"use client";

import { EmptyState } from "@/components/ui/states";
import { appHref } from "@/lib/auth-mode";

/** 桌面端未选会话时的主区。 */
export default function HomePage() {
	return (
		<div className="flex flex-1 items-center justify-center">
			<EmptyState
				mascotId="orgos-home"
				text="从左侧选一个会话，或去通讯录找同事聊聊。"
				action={{ label: "打开通讯录", href: appHref("/contacts") }}
			/>
		</div>
	);
}
