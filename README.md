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
bun run dev          # 服务端 + Next，ORGOS_DEV=1；有 DEEPSEEK_API_KEY 时为演示租户自动建好 DeepSeek 厂商，没有时自动 MOCK_LLM=1
```

打开 `http://localhost:8930/sim`：顶部勾选 1–4 位演示人物，每人一个窗格、各自以自己的身份登录；"重置演示数据"与 `seed:demo` 是同一个函数；右侧"剧本"列出 C1–C4 与 R 的操作步骤和可复制的话术。演示账号为 `<handle>@orgos.local`，密码是 `apps/server/src/demo/seed.ts` 里的 `DEMO_PASSWORD`，**仅限本地开发库使用**。未设置 `ORGOS_DEV=1` 时 `/sim` 与 `/api/dev/*` 返回 404。

服务端的 `BETTER_AUTH_SECRET` 未设置时使用仅限本地的默认值，任何对外部署都必须显式设置。

厂商 key 以 AES-256-GCM 加密入库，密钥由 `ORGOS_SECRET` 派生。开发模式（`ORGOS_DEV=1`）下未设置时使用 `apps/server/src/gateway/secret.ts` 里的 `DEV_SECRET`，**仅限本地**；非开发模式没有 `ORGOS_SECRET` 服务端拒绝启动。换了 `ORGOS_SECRET`，已存的 key 解不开，需要在"模型"页重填。

## 模型网关

服务端是本租户所有模型调用的唯一出口（`/llm/v1/chat/completions`、`/llm/v1/responses`、`/llm/v1/messages`、`/llm/v1/models`）：代理引擎经进程内调用，外部助手在企业模式下凭任务令牌调用；上游厂商有同一种协议就直通，没有就经统一中间结构翻译。租户 owner 在头像菜单的"模型"页管理厂商（预设表在 `packages/protocol/src/models.ts`）、开放的模型、路由组、默认模型与外部助手的模式；代理组页里每个代理可选模型（`厂商/模型` 或 `group/<id>`）。每次上游尝试在 `llm_requests` 记一行（带运行、任务、入口与上游协议）。

## 外部助手（Claude Code、Codex 等）

设备 Runner 以 ACP 驱动本机的外部 agent，把它们接成本人的助手（一次交办 = 一个任务）。适配器表在 `packages/protocol/src/acp.ts` 的 `ACP_ADAPTERS`：

| id | 启动 | 说明 |
|---|---|---|
| `claude-code` | `npx -y @zed-industries/claude-code-acp@0.16.2` | 读写与命令都经 Runner，限定工作目录、先审批；支持企业模式 |
| `codex` | `npx -y @zed-industries/codex-acp@0.16.0` | 支持企业模式 |
| `pi` | `npx -y pi-acp@0.0.34`（需本机 `pi`） | 第三方适配器；pi 在本机直接读写与执行，不经工作目录限制与审批 |
| `hermes` | `hermes acp` | 只对它自判危险的命令发权限请求，其余在本机直接执行 |
| `fake` | 仓库内 `apps/runner/test-fixtures/fake-acp-agent.ts` | 仅 `ORGOS_DEV=1`，测试用 |

Runner 启动时在后台探测（可执行文件在 PATH 上、且能回应 ACP `initialize`），探测结果随能力上报；`serve --adapters claude-code,codex` 限定这台设备提供哪些（`none` 为不提供）。之后在"代理组 → 接入外部助手"选设备、适配器与工作目录（须在设备工作目录之内）。外部 agent 的子进程看不到 runner token 与 Runner 的配置，orgos 不向它注入任何厂商密钥。

企业模式（默认）下，服务端为每个外部会话签发任务令牌随 `acp_start` 下发，Runner 按适配器表里每个适配器的 `enterprise` 注入规则，只用本次子进程的环境变量与参数把它指向 `<服务端>/llm`（claude-code 用 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` 等，codex 用 `-c` 定义临时厂商），不改 `~/.claude`、`~/.codex` 等任何配置文件；pi 与 Hermes 只支持个人模式。个人模式（须租户 owner 允许）不注入，用设备上自己的登录。
