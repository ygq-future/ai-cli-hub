# PROGRESS — 当前进度与决策日志

> **每个编码会话先读本文件**，了解现状后再动手；**每完成一个里程碑或做出关键决策后回来更新**。
> 这是项目的**动态状态真相源**。静态规矩见 [CLAUDE.md](./CLAUDE.md)，蓝图见 [05-实施计划](./docs/05-Implementation-Plan.md)。
>
> 最后更新：2026-07-05 · 阶段：**M6b（会话管理命令 & 生产级加固）**

---

## 1. 当前状态一览

| 维度 | 状态 |
|---|---|
| 当前里程碑 | **M6b — 会话管理命令 & 生产级加固**（实施中） |
| 代码 | ✅ M6 全量就绪（144 单测全绿 + 0 lint 违规 + 真机端到端三通路验证） |
| 文档 | ✅ 齐全 |
| 阻塞项 | 无 |
| 下一步 | 实施 M6b 五项修复（会话命令 / 重启映射 / 审批整轮取消 / 语言偏好 / CommandRouter） |

---

## 2. 里程碑进度（对齐 [05-实施计划](./docs/05-Implementation-Plan.md)）

| # | 里程碑 | 状态 | 备注 |
|---|---|---|---|
| M0 | 工程骨架 | ✅ 完成 | Bun+TS / src 骨架 / dependency-cruiser 依赖矩阵 / ESLint(defineConfig)禁 env 越界 / Prettier 格式化 / Pino logger / main 启动 |
| M1 | 配置与事件总线 | ✅ 完成 | config Zod(fail-fast, 唯一 env 入口) / EventBus(emit/on/once, 订阅者抛错隔离转 ErrorOccurred) + EventMap(Record 同步 ALL_EVENT_TYPES) / logger 订阅全部事件桥 / main 装配；17 单测 |
| M2 | 存储与仓储 | ✅ 完成 | Drizzle 四表(conversations/messages/audit_logs/memories) + enums / 迁移 0000_init(含 CREATE EXTENSION vector, embedding vector(1536), FTS gin, 无 HNSW) / bun-sql 连接 / 四 Repository(唯一 SQL 出口) + createRepositories 工厂 / schema 离线单测 5 + 集成测试 6(TEST_DATABASE_URL 守卫) |
| M3 | Core 状态机与会话生命周期 | ✅ 完成 | SessionMachine 纯状态机(11 合法/24 非法迁移+2 终态) + Auth(白名单 fail-closed) + SessionManager(findOrCreate/forceNew/close/transition/listStaleIdle) + MessageRouter(订阅 MessageReceived 事件, 存消息, 发 MessageGenerated) + MockHandler(模拟 Adapter 打通闭环) + CoreHub 装配；94 单测(含 62 状态机 + 6 Auth + 12 SessionManager 集成 + 14 Router 集成), depcruise 48 模块 0 违规 |
| M4 | Runtime 与 Claude Adapter | ✅ 完成 | CLIAdapter 语义接缝(cli/base) + ClaudeSdkAdapter(SDK 家族,持 query() 流式输入 + canUseTool 审批,queryFn 可注入测试) + PtyRuntime/NodePtyRuntime(node-pty,PTY 家族备用,spawnFn 可注入 + 空闲超时自杀) + 各家族 barrel 导出；main.ts TODO 更新；新增 19 单测(6 SDK 同步契约 + 6 SDK 假 query 驱动 + 7 PtyRuntime)；113 单测全绿, depcruise 57 模块 0 违规(D11)。**ApprovalDetector(PTY scraping)未做——无 SDK 的 CLI 接入时再补(M4b)** |
| M5 | 消息聚合器 | ✅ 完成 | MessageAggregator(core/aggregator, push/flush/destroy; 累计文本 Buffer + Debounce[debounceMs] + Throttle[minEditIntervalMs trailing 补发] + 超长拆分[maxChunkChars,优先换行处切], 发 MessageGenerated) + formatOutputDelta(cli/format-output, OutputDelta→展示串, tool_use 合成工具行) + main.ts bindAdapterOutput 接线(onOutput→format→push; final→flush, M6 每会话调用)。**content 语义定为累计全文(D12)**；新增 20 单测(13 aggregator + 7 format-output)；126 单测全绿, depcruise 61 模块 0 违规。AggregatorConfig 暂用默认常量(DEFAULT_AGGREGATOR_CONFIG 400/1000/4096), 未 env 化 |
| M6 | Telegram Transport | ✅ 完成 | 首个端到端。真机验证通过(见会话日志). **M6b 为质量闭环, 不单独列里程碑** |
| M6b | 会话管理命令 & 生产级加固 | 🟡 进行中 | 见 §4 下一步行动 |
| M7 | Audit 落地 | ⬜ 下一个 | 永久审计 |
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
| D8 | Postgres 驱动用 **drizzle-orm/bun-sql**（Bun 内置 SQL），零额外驱动依赖，遵「用 bun」。迁移应用走 **bun-sql migrator**（`scripts/migrate.ts`← `db:migrate`），因 `drizzle-kit migrate` 需外部 pg/postgres 驱动；`db:generate` 仍用 drizzle-kit（离线，无需驱动） | 2026-07-04 |
| D9 | 迁移沿用 drizzle-kit **0 基序号**（首个迁移 = `0000_init`，非 `0001`）——强改为 0001 会与后续自动生成的 `0001_*` 撞号；docs 中「迁移 0001」指此首迁移，内容为准 | 2026-07-04 |
| D10 | Repository 契约接口置于 **`src/repository/types.ts`**（非 shared/）：实体类型由 Drizzle `$inferSelect/$inferInsert` 推导必居 storage/，shared/ 是叶子不可依赖 storage/；core/ 经 repository/ 取领域类型（依赖矩阵允许 core→repository、repository→storage） | 2026-07-04 |
| D11 | **执行层接缝在语义化 `CLIAdapter`（非 `Runtime`）；Claude 走 `@anthropic-ai/claude-agent-sdk`（SDK 家族），node-pty 仅作无 SDK 的 CLI 备用（PTY 家族）**。要点：① Core/Transport 只依赖语义 `CLIAdapter`；② 审批 SDK 侧走 `canUseTool`（结构化）、PTY 侧走 `ApprovalDetector`（正则 scraping，仅 PTY 专属）；③ `Runtime`→`PtyRuntime`，PTY 家族内部件，SDK Adapter 不实现不使用；④ 厂商中立靠「每 CLI 一个 Adapter 实现 `CLIAdapter`」，不造共享 SDK 基类。 | 2026-07-04 |
| D12 | **`MessageGenerated.content` = 当前消息的累计全文（非增量 delta）**：聚合器流式 emit 发累计 buffer(final=false)；`flush`/拆分发 final=true 定稿；拆分=定稿当前条(final=true)并开启下一条。Transport 按会话维护「当前草稿 MessageRef」：final=false 首次 sendMessage 存 ref、后续 editMessage(ref)，final=true 定稿并清 ref | 2026-07-04 |
| D13 | **`MessageReceived` 去 `conversationId`，改由 Core 解析会话**：Transport 出参 { userId, platform, cli, cwd, text, ref }；MessageRouter 订阅后调 `sessionManager.findOrCreate` 解析/新建 conversation。配套：`SessionCreated` 事件（含 userId）使 Transport 维护 convChat 映射。 | 2026-07-05 |
| D14 | **`SessionMapped` 事件解决跨进程重启映射丢失**：`findOrCreate` 复用分支发射 `SessionMapped{conversationId,userId,platform}`。Transport 订阅同一 handler 更新 convChat。 | 2026-07-05 |
| D15 | **审批拒绝触发整轮取消**：`CLIAdapter` 新增 `interrupt()` 接口；`ClaudeSdkAdapter` 实现为 `query.interrupt()`。orchestrator 订阅 `ApprovalRejected` + `interrupt()` 阻止 Claude 换工具重试。 | 2026-07-05 |
| D16 | **语言偏好的系统注入**：Transport 维持 `userLang Map`；`/lang <zh|en>` 切换；`CLIAdapter.StartOptions` 加 `systemLanguageHint`；orchestrator 注入到 adapter.start。 | 2026-07-05 |

---

## 4. 下一步行动（Next Actions）

**M6b — 会话管理命令 & 生产级加固**（当前）：

### 变更清单

**会话管理命令**（`transport/telegram/telegram-transport.ts` + 新增 `core/commands.ts`）：
1. 新增 `/close` —— 关闭当前会话（SessionClosed → db closed → 清理 adapter）
2. 新增 `/new` —— 强制开新会话（旧 idle 建新 → SessionCreated）
3. 新增 `/status` —— 显示当前会话状态 + id + 存活时长
4. 新增 `/sessions` —— 列出该用户最近 10 条历史会话（状态/日期/cwd）

**重启映射修复**（`core/session-manager.ts` + `transport/telegram/telegram-transport.ts`）：
5. `findOrCreate` 复用分支发射 `SessionMapped` 事件（D14）
6. Transport 订阅 `SessionMapped` + `SessionCreated` 同一 handler 更新 convChat

**审批整轮取消**（`core/commands.ts` + `orchestrator.ts` + `cli/base.ts`）：
7. `CLIAdapter` 接口加 `interrupt(): void`
8. `ClaudeSdkAdapter.start` 存 `query` 引用；`interrupt()`→ `query.interrupt()`
9. orchestrator `ApprovalRejected` 订阅调 `adapter.interrupt()` 停止当前 query

**语言偏好**（`transport/telegram/` + `orchestrator.ts` + `cli/base.ts`）：
10. Transport 维持 `userLang: Map<userId, 'zh'|'en'>`；`/lang <zh|en>` 切换；默认 `zh`
11. `CLIAdapter.StartOptions` 加 `systemLanguageHint?: string`
12. orchestrator `ensureAdapter` 查 lang 并注入到 `adapter.start({ systemLanguageHint })`
13. `ClaudeSdkAdapter.start` 将 `systemLanguageHint` 作为首条 system 消息喂入

**后端逻辑**：
14. 新增 `core/commands.ts` 导出 `CommandRouter`——区分系统命令与普通文本
15. `MessageRouter` 处理 `/` 开头消息时先走 `CommandRouter`
16. `main.ts` 装配 CommandRouter→注入 CoreHub/router

### 验收

- `bun run typecheck` ✅ · `bun run format` ✅ · `bun run lint` 0 违规 ✅ · `bun test` 全绿 ✅
- 真机验证四轮：
  ① `/status`→正确会话信息 → `/close`→会话 closed → 再发消息→新建会话 → `/new`→旧 idle 新会话
  ② 重启服务后发消息→回复正常落地（SessionMapped 修复）
  ③ 审批点 Reject→整轮停止（不弹第二卡）
  ④ `/lang zh`→中文回复；`/lang en`→英文回复

**M7 — Audit 落地**（M6b 之后）：
1. 审批决议订阅 → SessionMachine `waitingApproval→running` 迁移
2. SessionCreated/SessionClosed → DB 状态同步
3. AuditRepository 全程纪录
4. main.ts 装配

**M8 — 记忆基础**（M7 之后）：
- memory/ 订阅 MessageGenerated → 异步摘要；跨会话回放

---

## 5. 会话日志（Changelog）

> 每个工作会话追加一行：日期 · 做了什么 · 产出/决策。

| 日期 | 内容 |
|---|---|
| 2026-07-03 | 撰写 01-PRD、02-Architecture；确定长期记忆方案；产出护栏文档集；建立本进度文件 |
| 2026-07-03 | **M0 完成**：搭建 src 骨架（12 模块）、logger(Pino)、shared 基础类型、depcruise 依赖矩阵、ESLint 禁 env 越界；typecheck/lint/start 三项通过 |
| 2026-07-03 | 补 CLAUDE.md 硬规矩：对齐 PROGRESS.md；禁自动 git commit/push |
| 2026-07-03 | **M1 完成**：config(Zod + loadConfig, fail-fast, 唯一 env) + event(EventBus, EventMap, ALL_EVENT_TYPES 强同步) + logger 事件桥；17 单测全绿 |
| 2026-07-04 | **M2 完成**：storage(四表 schema, pgvector, FTS, 迁移 0000_init) + repository(四 Repository, 工厂)；db:generate + db:migrate 真库成功；22 单测全绿 |
| 2026-07-04 | **M2 连库验证**：本地 pgvector 容器 → 建 ai_cli_hub_test 库 → db:migrate 成功(幂等 no-op) → 26 单测试 0 失败 |
| 2026-07-04 | **M3 完成**：SessionMachine(11 合法/24 非法) + Auth(白名单 fail-closed) + SessionManager + MessageRouter + CoreHub；94 单测全绿 |
| 2026-07-04 | barrel import 简写 + CLAUDE.md 规则 13/14 |
| 2026-07-04 | **M4 完成**：CLIAdapter 语义接缝 + ClaudeSdkAdapter(SDK 家族 canUseTool) + PtyRuntime(node-pty 备用)；113 单测全绿。ApprovalDetector 留待 M4b |
| 2026-07-04 | **M4 真·连通验证**：`scripts/smoke-claude.ts` 真 spawn 本机 claude CLI 端到端跑通 |
| 2026-07-05 | **M5 完成**：MessageAggregator(Buffer+Debounce+Throttle+超长拆分) + formatOutputDelta + main.ts bindAdapterOutput 接线；126 单测全绿 |
| 2026-07-05 | **M6 完成**：Telegram Transport(Telegraf) 首端到端——白名单+出站流式 editMessage + 审批卡+ /start /help。**D13**: MessageReceived 去 conversationId。140 单测全绿。依赖新增: telegraf |
| 2026-07-05 | **M6 真机联调通过 + 两处修复**：① Windows 连通修复（Bun 只认 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量,不读系统代理注册表；`.env` 顶部加两行就通）推翻前会话错误论断。② 真机端到端跑通：TG→MessageReceived→SessionCreated→ClaudeSdkAdapter→流式回复。③ **Markdown 渲染修复**(引入 telegramify-markdown + MarkdownV2)。141 单测全绿。依赖新增: telegramify-markdown |
| 2026-07-05 | **M6 真机联调二轮修复（生产级加固）**：④ 出站 sendFormatted/editFormatted 加 400 解析错误降级纯文本(消息永不丢失)。⑤ 审批卡 doSendApproval 同理降级(按钮保留)。⑥ detail 反斜杠双写转义(Windows 路径完整)。144 单测全绿 |
| 2026-07-05 | **🎯 M6b 规划对齐**：真机暴露问题汇总为 M6b 工作包(会话命令/重启映射/审批整轮取消/语言偏好/CommandRouter)；PROGRESS.md 完整重建(清理之前 Edit 残留的 tab 嵌套格式)；新增 D14/D15/D16 |

---

## 6. 开放问题（Open Questions）

> 尚未决策、需要时再定的事项。清空表示当前无悬而未决。

- （暂无）
