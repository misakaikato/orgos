"use client";

import { use } from "react";
import { ConversationView } from "@/components/conversation/conversation-view";

export default function ConversationPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ t?: string }>;
}) {
	const { id } = use(params);
	const { t } = use(searchParams);
	return <ConversationView key={id} conversationId={id} topicId={t} />;
}
