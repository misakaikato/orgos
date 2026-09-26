import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

/** 只测纯逻辑模块（node 环境，不渲染组件）。别名与 tsconfig 的 paths 一致。 */
export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(root, "src"),
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
	},
});
