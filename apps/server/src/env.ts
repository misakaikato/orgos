/**
 * 集中读取环境变量。默认值对应本地开发环境（scripts/dev-db.sh 起的库、服务端 8930）。
 */
export const env = {
	DATABASE_URL:
		process.env.DATABASE_URL ?? "postgresql://orgos:orgos@127.0.0.1:5470/orgos",
	/** 仅限本地开发的默认值；任何对外部署都必须显式设置。 */
	BETTER_AUTH_SECRET:
		process.env.BETTER_AUTH_SECRET ?? "orgos-local-dev-secret-not-for-deploy",
	BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:8930",
	PORT: Number(process.env.PORT ?? 8930),
	/** 内部 Next 进程；浏览器只经服务端访问它。 */
	NEXT_INTERNAL_URL: process.env.NEXT_INTERNAL_URL ?? "http://127.0.0.1:3930",
} as const;
