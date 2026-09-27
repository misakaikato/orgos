import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

export const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgresql://orgos:orgos@127.0.0.1:5470/orgos_test";

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(root, "src"),
		},
	},
	test: {
		environment: "node",
		env: {
			DATABASE_URL: TEST_DATABASE_URL,
			// 测试一律用确定性的假模型，不出网。
			MOCK_LLM: "1",
		},
		globalSetup: ["./tests/global-setup.ts"],
		include: ["tests/**/*.test.ts"],
		// 集成用例共用一个真实库，按文件串行，避免跨文件竞态。
		fileParallelism: false,
	},
});
