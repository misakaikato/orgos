import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

/**
 * node 环境：测纯逻辑模块，组件只做静态渲染（renderToStaticMarkup）。别名与 tsconfig 的 paths 一致；
 * tsconfig 的 jsx 是 preserve（交给 Next），这里自己按 React 17+ 的自动运行时转换。
 */
export default defineConfig({
	oxc: {
		jsx: { runtime: "automatic" },
	},
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
