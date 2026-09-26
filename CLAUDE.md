# orgos

AI 原生办公实验：人与各自的代理组在同一个即时通讯里协作。

- 合同：`specs/2026-09-26-phase1-mvp.md`，与任何其他文档冲突时以它为准。
- 界面：动手前读 `DESIGN.md`，只用 `apps/web/src/app/tokens.css` 里的变量。
- 决策记录：`decisions/`。

## 约定

- TypeScript strict、Bun workspaces、Tab 缩进、`@/` 绝对路径导入、依赖版本精确钉死。
- 所有业务查询经 `scoped(tenantId)`；`events` 表只追加。
- 协议在 `packages/protocol`，只增不改（新字段一律可选）。
- `apps/runner` 里不出现任何 LLM 调用或密钥。
- 本机 shell 有 `HTTP_PROXY`：脚本一律带 `NO_PROXY=localhost,127.0.0.1`。
- 门禁命令 `bun run typecheck` / `bun run lint` / `bun run test` 分开跑、看真实退出码，不接管道。
- 读 DeepSeek key 只用 `DEEPSEEK_API_KEY=$(jq -r .deepseek.key ~/.pi/agent/auth.json)` 内联注入，绝不打印或查看该文件全文（里面有其他 OAuth 令牌）。
- 提交信息：emoji + 中文，不加 Co-Authored-By。
