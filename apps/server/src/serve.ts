/** Bun 运行入口：`bun run src/serve.ts`。 */
import { env } from "@/env";
import { app } from "@/index";

export default {
	port: env.PORT,
	fetch: app.fetch,
};
