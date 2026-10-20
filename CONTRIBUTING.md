# 参与

这是一个个人实验项目，没有贡献流程上的讲究：开 issue 说想法，或直接提 PR。

## 提 PR 之前

1. 在 PR 里确认你同意 [CLA.md](CLA.md)（模板里已预置确认行）。**没确认的不合并。**
2. 下列门禁各自退出码为 0，CI 也会跑同样的命令：

   ```bash
   bun install
   bun run dev:db       # 需要 Docker：Postgres 16，端口 5470
   bun run db:migrate
   bun run typecheck
   bun run lint
   bun run test         # 会重置并使用 orgos_test 库
   bun run e2e          # 假模型端到端，不出网
   ```

3. 改动涉及界面时先读 [DESIGN.md](DESIGN.md)；涉及架构时先读 [docs/architecture.html](docs/architecture.html)。

## 约定

- TypeScript strict、Tab 缩进、`@/` 绝对路径导入、依赖版本精确钉死。
- 所有业务查询经 `scoped(tenantId)`；`events` 表只追加。
- `packages/protocol` 里的协议只增不改，新字段一律可选。
- 提交信息：emoji 开头 + 中文简述。

## 我该从哪里开始

「场景走查」（README）里列的六个场景是最快上手的入口。想聊方向再动手，开个 issue。
