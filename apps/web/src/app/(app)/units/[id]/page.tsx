"use client";

import { use } from "react";
import { UnitView } from "@/components/org/unit-view";

export default function UnitPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = use(params);
	return <UnitView key={id} unitId={id} />;
}
