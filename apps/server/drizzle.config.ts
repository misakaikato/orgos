import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		url:
			process.env.DATABASE_URL ??
			"postgresql://orgos:orgos@127.0.0.1:5470/orgos",
	},
	verbose: true,
	strict: true,
});
