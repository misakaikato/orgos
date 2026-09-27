# orgos

AI 原生办公实验：人与各自的代理组在同一个即时通讯里协作。规格见 [specs/2026-09-26-phase1-mvp.md](specs/2026-09-26-phase1-mvp.md)。

## 本地启动

```bash
bun install
bun run dev:db       # Postgres 16 容器 orgos-postgres，端口 5470，库 orgos 与 orgos_test
bun run db:migrate
bun run seed         # 测试账号（幂等）
bun run --cwd apps/server dev   # 服务端 http://localhost:8930
```

门禁：`bun run typecheck`、`bun run lint`、`bun run test`（集成测试会重置并使用 `orgos_test` 库）。

## 测试账号（仅限本地）

`bun run seed` 建两个租户，密码统一为 `scripts/seed.ts` 里的 `SEED_PASSWORD`，**仅限本地开发库使用**：

| 租户 | 账号 |
|---|---|
| 测试公司 | `alice@orgos.local`（owner）、`bob@orgos.local`、`carol@orgos.local` |
| 别家公司 | `dave@orgos.local` |

## 演示数据与模拟台（仅限本地）

```bash
bun run seed:demo    # 幂等：删除并重建"星河科技"（linxiao 林晓、zhouye 周野、chenan 陈安、xunuo 许诺）与"别家公司"（waibu）
bun run dev          # 服务端 + Next，ORGOS_DEV=1；没有 DEEPSEEK_API_KEY 时自动 MOCK_LLM=1
```

打开 `http://localhost:8930/sim`：顶部勾选 1–4 位演示人物，每人一个窗格、各自以自己的身份登录；"重置演示数据"与 `seed:demo` 是同一个函数；右侧"剧本"列出 C1–C4 与 R 的操作步骤和可复制的话术。演示账号为 `<handle>@orgos.local`，密码是 `apps/server/src/demo/seed.ts` 里的 `DEMO_PASSWORD`，**仅限本地开发库使用**。未设置 `ORGOS_DEV=1` 时 `/sim` 与 `/api/dev/*` 返回 404。

服务端的 `BETTER_AUTH_SECRET` 未设置时使用仅限本地的默认值，任何对外部署都必须显式设置。
