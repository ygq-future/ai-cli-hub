# PROGRESS — 当前进度与决策日志

> **每个编码会话先读本文件**，了解现状后再动手；**每完成一个里程碑或做出关键决策后回来更新**。
> 这是项目的**动态状态真相源**。静态规矩见 [CLAUDE.md](./CLAUDE.md)，蓝图见 [05-实施计划](./docs/05-Implementation-Plan.md)。
>
> 最后更新：2026-07-04 · 阶段：**M4 完成（Runtime 与 Claude Adapter），进入 M5（消息聚合器）**

---

## 1. 当前状态一览

| 维度 | 状态 |
|---|---|
| 当前里程碑 | **M5 - 消息聚合器**（未开始） |
| 代码 | ✅ M4 就绪（CLIAdapter 语义接缝 + ClaudeSdkAdapter[SDK 家族,canUseTool 审批] + PtyRuntime[node-pty,PTY 家族备用]；**113 单测全绿 + 0 lint 违规 + 57 模块 depcruise 通过**） |
| 文档 | ✅ 齐全 |
| 阻塞项 | 无 |
| 下一步 | M5：MessageAggregator（Buffer/Debounce/Throttle/拆分），把 adapter 输出流聚合为 MessageGenerated |

---

## 2. 里程碑进度（对齐 [05-实施计划](./docs/05-Implementation-Plan.md)）

| # | 里程碑 | 状态 | 备注 |
|---|---|---|---|
| M0 | 工程骨架 | ✅ 完成 | Bun+TS / src 骨架 / dependency-cruiser 依赖矩阵 / ESLint(defineConfig)禁 env 越界 / Prettier 格式化 / Pino logger / main 启动 |
| M1 | 配置与事件总线 | ✅ 完成 | config Zod(fail-fast, 唯一 env 入口) / EventBus(emit/on/once, 订阅者抛错隔离转 ErrorOccurred) + EventMap(Record 同步 ALL_EVENT_TYPES) / logger 订阅全部事件桥 / main 装配；17 单测 |
| M2 | 存储与仓储 | ✅ 完成 | Drizzle 四表(conversations/messages/audit_logs/memories) + enums / 迁移 0000_init(含 CREATE EXTENSION vector, embedding vector(1536), FTS gin, 无 HNSW) / bun-sql 连接 / 四 Repository(唯一 SQL 出口) + createRepositories 工厂 / schema 离线单测 5 + 集成测试 6(TEST_DATABASE_URL 守卫) |
| M3 | Core 状态机与会话生命周期 | ✅ 完成 | SessionMachine 纯状态机(11 合法/24 非法迁移+2 终态) + Auth(白名单 fail-closed) + SessionManager(findOrCreate/forceNew/close/transition/listStaleIdle) + MessageRouter(订阅 MessageReceived 事件, 存消息, 发 MessageGenerated) + MockHandler(模拟 Adapter 打通闭环) + CoreHub 装配；94 单测(含 62 状态机 + 6 Auth + 12 SessionManager 集成 + 14 Router 集成), depcruise 48 模块 0 违规 |
| M4 | Runtime 与 Claude Adapter | ✅ 完成 | CLIAdapter 语义接缝(cli/base) + ClaudeSdkAdapter(SDK 家族,持 query() 流式输入 + canUseTool 审批,queryFn 可注入测试) + PtyRuntime/NodePtyRuntime(node-pty,PTY 家族备用,spawnFn 可注入 + 空闲超时自杀) + 各家族 barrel 导出;main.ts TODO 更新;新增 19 单测(6 SDK 同步契约 + 6 SDK 假 query 驱动 + 7 PtyRuntime);113 单测全绿, depcruise 57 模块 0 违规(D11)。**ApprovalDetector(PTY scraping)未做——无 SDK 的 CLI 接入时再补(M4b)** |
| M5 | 消息聚合器 | 🟡 下一个 | Buffer/Debounce/Throttle/拆分 |
| M6 | Telegram Transport | ⬜ | 首个端到端 |
| M7 | Audit 落地 | ⬜ | 永久审计 |
| M8 | 记忆基础（V1：关系+FTS） | ⬜ | 跨会话摘要回放 |
| M9 | 加固与交付 | ⬜ | 优雅关闭 / 故障隔离 / 部署 |
| V1.5 | 记忆增强（pgvector） | ⬜ | 非 V1 阻塞项 |

图例：⬜ 未开始 · 🟡 进行中 · ✅ 完成 · ⚠️ 受阻

---

## 3. 关键决策日志（已拍板，勿再翻案）

> 这些是已达成一致的决策，编码时直接遵循，不要重新讨论或改变方向。详细权衡见 [02-架构 ADR 附录](./docs/02-Architecture.md)。

| # | 决策 | 定稿于 |
|---|---|---|
| D1 | 数据库 V1 即用 **Postgres + Drizzle**（非 SQLite），一次定库避免二次迁移 | 2026-07-03 |
| D2 | 向量用 **pgvector 同库**；V1 预留 `embedding` 列留空，**V1.5** 启用 HNSW 索引 | 2026-07-03 |
| D3 | 嵌入**只走 API**（`text-embedding-3-small`），**不在 VPS 跑本地模型**；异步批量 | 2026-07-03 |
| D4 | 会话边界 = `(user_id, cli, cwd)` 复用 + `/new` 开新 + `/close`/超期归档 | 2026-07-03 |
| D5 | **进程回收 ≠ 会话关闭**：PTY 空闲超时转 `idle`，`closed` 仅由 `/close`/归档触发 | 2026-07-03 |
| D6 | 记忆分 **user-level / conversation-level 两层**；跨会话回放取 user-level + 相关 episodic 摘要 | 2026-07-03 |
| D7 | 文档集定为 CLAUDE.md + 01–07 + .env.example（不单列安全/ADR/贡献指南） | 2026-07-03 |
| D8 | Postgres 驱动用 **drizzle-orm/bun-sql**（Bun 内置 SQL），零额外驱动依赖，遵「用 bun」。迁移应用走 **bun-sql migrator**（`scripts/migrate.ts` ← `db:migrate`），因 `drizzle-kit migrate` 需外部 pg/postgres 驱动；`db:generate` 仍用 drizzle-kit（离线，无需驱动） | 2026-07-04 |
| D9 | 迁移沿用 drizzle-kit **0 基序号**（首个迁移 = `0000_init`，非 `0001`）——强改为 0001 会与后续自动生成的 `0001_*` 撞号；docs 中「迁移 0001」指此首迁移，内容为准 | 2026-07-04 |
| D10 | Repository 契约接口置于 **`src/repository/types.ts`**（非 shared/）：实体类型由 Drizzle `$inferSelect/$inferInsert` 推导必居 storage/，shared/ 是叶子不可依赖 storage/；core/ 经 repository/ 取领域类型（依赖矩阵允许 core→repository、repository→storage） | 2026-07-04 |
| D11 | **执行层接缝在语义化 `CLIAdapter`（非 `Runtime`）；Claude 走 `@anthropic-ai/claude-agent-sdk`（SDK 家族），node-pty 仅作无 SDK 的 CLI 备用（PTY 家族）**。要点：① Core/Transport 只依赖语义 `CLIAdapter`（一轮输入/流式输出/审批请求+决定/生命周期），字节 vs 结构化差异封在 Adapter 内部；② 审批 SDK 侧走 `canUseTool`（拿工具名+参数，结构化）、PTY 侧走 `ApprovalDetector`（正则 scraping，仅 PTY 专属）；③ `Runtime`→`PtyRuntime`，PTY 家族内部件，SDK Adapter 不实现不使用——删原"未来替换 SdkRuntime、Adapter 不感知"假承诺（审批形态不对称使其不成立）；④ 厂商中立靠"每 CLI 一个 Adapter 实现 `CLIAdapter`"，**不**造共享 SDK 基类。已验证：SDK peerDeps `zod ^4.0.0`（与本项目一致，无冲突）、体积 +5.5MB（含原生二进制，依赖树干净）、`canUseTool(toolName,input)→allow/deny`。已同步 CLAUDE.md（§2 技术栈 + §3 依赖矩阵 cli/* 允许依赖 SDK + §4 目录职责 + §8 扩展指引）与 01/02/03/05/06/07 全部文档 | 2026-07-04 |

---

## 4. 下一步行动（Next Actions）

**M5 — 消息聚合器**（当前）：
1. `core/aggregator.ts`（或独立模块）：实现 `MessageAggregator`（`push`/`flush`），Buffer + Debounce + Throttle + 超长拆分（TG 4096）。
2. 把 CLIAdapter 的 `onOutput` 流接入聚合器 → 聚合后发 `MessageGenerated`。
3. SDK 家族输出本就离散（SDKMessage），debounce 压力小；PTY 家族高频字节需重点去抖。
4. 单测：push/flush/debounce/拆分边界。
5. 通过验收 → 更新本文件（M5 → ✅，M6 → 🟡）→ 进入 M6。

> **依赖就绪**：CLIAdapter.onOutput（03 §3.1）、AggregatorConfig（03 §4）、MessageGenerated 事件（EventMap）。

**M4 验收留痕**：`bun run typecheck` ✅ · `bun run lint`（eslint + depcruise **57 模块 136 依赖 0 违规**）✅ · `bun run format:check` ✅ · `bun test` **113 pass / 6 skip / 0 fail**（+19：6 SDK 同步契约 + 6 SDK 假 query 驱动[输出映射/审批 allow-deny/重复 start] + 7 PtyRuntime[data/exit/write/resize/超时自杀/退订]）✅

> 备注：SDK 依赖 `@anthropic-ai/claude-agent-sdk@0.3.201`、`node-pty@1.1.0` 已装。adapter/runtime 均用「可注入 fn」接缝（queryFn / spawnFn）单测，不真起子进程。`bun run start` 仍不完整（缺 DB + adapter 接入完整消息流，待 M5/M6）。

---

## 5. 会话日志（Changelog）

> 每个工作会话追加一行：日期 · 做了什么 · 产出/决策。

| 日期 | 内容 |
|---|---|
| 2026-07-03 | 撰写 01-PRD、02-Architecture；确定长期记忆方案（Postgres+pgvector、API 嵌入、两层记忆）；同步 PRD/架构；产出护栏文档集（CLAUDE.md、03–07、.env.example）；建立本进度文件 |
| 2026-07-03 | **M0 完成**：搭建 src 骨架（12 模块）、logger(Pino)、shared 基础类型、dependency-cruiser 依赖矩阵校验、ESLint 禁 env 越界；typecheck/lint/start 三项验收通过 |
| 2026-07-03 | 补 CLAUDE.md 硬规矩：完成阶段性任务必须对齐 PROGRESS.md；未经指令禁止 git commit/push |
| 2026-07-03 | **M1 完成**：config（Zod schema + loadConfig，fail-fast，唯一 env 入口，注入 source 便于测试）；event（EventBus emit/on/once，订阅快照安全，订阅者抛错隔离转 ErrorOccurred 且不回环；EventMap + Record 强同步 ALL_EVENT_TYPES）；logger 事件桥（订阅全部事件，级别路由，返回 detach）；main 装配 config→logger→bus→桥；新增依赖 zod@4；17 单测 + typecheck + lint(0 违规) + start 全绿 |
| 2026-07-04 | **M2 完成**：storage（enums + 四表 schema，pgvector customType vector(1536)，FTS gin 索引；createDb 走 drizzle-orm/bun-sql[D8]）；离线 `db:generate` 产出 `drizzle/0000_init.sql`[D9] 并手工前置 `CREATE EXTENSION vector`；repository（types.ts 契约[D10] + 四 Repository 实现 + createRepositories 工厂，searchByVector 留桩 V1.5）；测试（schema 离线 5 通过 + 集成 6 项 TEST_DATABASE_URL 守卫 skip）；eslint 加 `^_` 未用参数放行；新增依赖 drizzle-orm / drizzle-kit(dev)；typecheck + lint(0 违规,40 模块) + format:check + 22 单测全绿。**真·连库迁移/CRUD 待用户备库后验证** |
| 2026-07-04 | **M2 连库验证**：用户本地 pgvector/pgvector:pg16（5432）→ 建 `ai_cli_hub_test` 库；`db:migrate` 改用 bun-sql migrator（`scripts/migrate.ts`，因 drizzle-kit migrate 需外部驱动，与 D8「零额外驱动」冲突）；迁移建库成功（vector 扩展 + 4 表 + 7 索引 + `embedding vector(1536)`，幂等复跑 no-op）；全量 `bun test` 含 4 项连库 CRUD **26 通过 / 0 失败**。M2 验收全绿 |
| 2026-07-04 | **M3 完成**：SessionMachine 纯状态机（11 条合法 + 24 条非法迁移 + 终态防护） + Auth（白名单 fail-closed 二次校验）+ SessionManager（findOrCreate 复用/新建、forceNew 置旧 idle、close 转 closed、transition 委托状态机、listStaleIdle 归档扫描、事件发射）+ MessageRouter（订阅 MessageReceived、存 user/assistant 消息、MockHandler 模拟响应、发 MessageGenerated）+ CoreHub 装配（SessionManager + Auth + Router）+ main.ts TODO 更新。**验收**：typecheck ✅ · format:check ✅ · lint 0 error（depcruise 48 模块 115 依赖 0 违规）✅ · bun test **94 pass / 6 skip / 0 fail** ✅ |
| 2026-07-04 | barrel import 简写（`../shared` / `../repository`）：源码 5 处 import 收敛，repository/index.ts 补 re-export ConversationId/MessageId/CliType/SessionStatus；CLAUDE.md §5 加规则 13（barrel 优先）+ 补回规则 14（写完必格式化）。commit `d389486` |
| 2026-07-04 | **M4 完成**：CLIAdapter 语义接缝（cli/base，Core/Transport 唯一依赖）+ ClaudeSdkAdapter（SDK 家族：异步输入队列喂 query() 流式输入、assistant→onOutput(final=false)/result→final=true、canUseTool→onApprovalRequest 挂起 Promise、resolveApproval 决议 allow/deny、interrupt/stop；queryFn 可注入测试）+ PtyRuntime/NodePtyRuntime（PTY 家族备用：node-pty spawn/write/kill/resize/onData/onExit、空闲超时自杀；spawnFn 可注入测试）+ cli//runtime/ barrel 导出。新增依赖 node-pty@1.1.0 + @anthropic-ai/claude-agent-sdk@0.3.201。env 越界修正：SDK/node-pty 省略 env 即继承 process.env，不自读（遵 §5）。**验收**：typecheck ✅ · format:check ✅ · lint 0 error（depcruise 57 模块 136 依赖 0 违规）✅ · bun test **113 pass / 6 skip / 0 fail**（+19）✅。ApprovalDetector(PTY scraping) 留待 M4b |
| 2026-07-04 | **M4 真·连通验证**：`scripts/smoke-claude.ts` 真 spawn 本机 claude CLI(v2.1.200,OAuth 凭证,无 ANTHROPIC_API_KEY)→ 发 "say hi in exactly 3 words" → 收到 "Hi there friend" + final，`ClaudeSdkAdapter` 端到端跑通。**修正上条留痕的夸大**：113 单测仅逻辑自洽（假驱动 mock，不碰真 SDK）；本次才是真实连接验证。SDK 家族确认可用 |

---

## 6. 开放问题（Open Questions）

> 尚未决策、需要时再定的事项。清空表示当前无悬而未决。

- （暂无）
