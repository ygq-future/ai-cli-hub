# PROGRESS — 当前进度与决策日志

> **每个编码会话先读本文件**，了解现状后再动手；**每完成一个里程碑或做出关键决策后回来更新**。
> 这是项目的**动态状态真相源**。静态规矩见 [CLAUDE.md](./CLAUDE.md)，蓝图见 [05-实施计划](./docs/05-Implementation-Plan.md)。
>
> 最后更新：2026-07-06 · 阶段：**M6b（会话管理命令 & 生产级加固完成）**

---

## 1. 当前状态一览

| 维度 | 状态 |
|---|---|
| 当前里程碑 | **M6b — 会话管理命令 & 生产级加固**（完成） |
| 代码 | ✅ M6b 全部真机复测完成；format/typecheck/lint/test 全绿 |
| 文档 | ✅ 齐全 |
| 阻塞项 | 无 |
| 下一步 | 进入 **M7 Audit 落地**：审批决议、会话生命周期与关键操作写入永久审计 |

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
| M6b | 会话管理命令 & 生产级加固 | ✅ 完成 | `/new` `/cwd` `/status` `/sessions` `/lang`、状态流转、SDK 输出源、TG 展示与审批回归均已真机复测 |
| M7 | Audit 落地 | ⬜ 下一个 | 永久审计 |
| M8 | 全局记忆基础 | ⬜ | M8-A 环境快照记忆优先落地；随后做 adapter 注入、`/remember`、`/memory`/`/forget` |
| M9 | 媒体/文件处理 + OCR/Vision | ⬜ | emoji 归一化、sticker metadata、文件/图片/PDF/Office 解析、OCR 默认开启，Vision 可选增强 |
| M10 | 加固与交付 | ⬜ | 优雅关闭 / 故障隔离 / 部署 |
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
| D5 | **运行时回收 ≠ 会话关闭**：CLI/adapter 空闲超时仅关闭已启动运行时并让会话保持 `idle`。`closed` 由 `/close`、`/new`、`/cwd <path>` 或归档触发（D29/D30 对原始表述做了收口修正）。 | 2026-07-03 |
| D6 | 记忆分 **user-level / conversation-level 两层**；M8 收口为先做 user-level 命令式全局记忆与环境记忆，conversation-level 摘要后续用于归档/召回（D32）。 | 2026-07-03 |
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
| D17 | **语言偏好是用户级运行期状态，不是单会话 DB 字段**：`/lang zh\|en` 影响该用户后续所有会话/adapter 启动，`/status` 显示当前用户语言；当前实现为 Transport 内存态，进程重启后回默认 `zh`，持久化留待后续偏好/记忆模块。 | 2026-07-05 |
| D18 | **`/new [cli] [cwd]` 切换用户当前目标会话边界**：Transport 在 `SessionCreated` 后记住该用户当前 `cli/cwd`，后续普通消息使用这个目标，而不是永久固定 `DEFAULT_CWD`。 | 2026-07-05 |
| D19 | **Agent SDK 原始 JSON 调试只做 opt-in**：`.env` 通过 `DEBUG_AGENT_SDK_JSON=true/1/on` 开启；配置仍由 `config/` 解析，`main.ts` 注入 adapter，Claude adapter 不直接读取 env。 | 2026-07-05 |
| D20 | **工具审批按“是否改变状态”而非工具名一刀切**：`Read/Glob/Grep/WebFetch` 等只读工具自动放行；`Bash` 仅对单条保守查询命令（如 `ls/dir/pwd/cat/head/tail/wc/grep/git status|log|show|diff`）自动放行；含重定向、管道、串联、替换或写操作的 Bash 仍走审批。不做“你好/hello”等输入字面量特判，避免误伤模型行为。 | 2026-07-05 |
| D21 | **Telegram 展示层将 Windows drive path 归一为正斜杠**：出站渲染前把 `D:\Users\...` 等展示成 `D:/Users/...`，继续启用 MarkdownV2；降级纯文本也使用同一归一化，避免反斜杠导致粗体/行内代码失效。 | 2026-07-06 |
| D22 | **文件/命令操作不得“口头完成”**：Claude adapter 启动时追加操作结果护栏；创建/修改/删除/移动/检查本地文件或运行命令时，必须调用工具并拿到成功结果后才能声称完成，工具未调用/被拒/失败必须说明未完成。 | 2026-07-06 |
| D23 | **Claude SDK 会话默认隔离宿主自定义能力但保留认证来源**：不覆盖 `settingSources`，让 SDK 继续复用宿主 Claude CLI 的认证 token；默认传 `skills: []`、`plugins: []`、`strictMcpConfig: true`，并通过 settings 禁用 bundled skills 与 hooks，隔离插件/skills/hooks/外部 MCP。 | 2026-07-06 |
| D24 | **进程关闭必须等待 adapter.stop 完成**：`SessionOrchestrator.destroy()` 改为 async，收集并 await 所有会话 adapter.stop；main shutdown await transport/orchestrator/aggregator/coreHub 后再 `process.exit`，降低 `bun dev` 退出时 Claude 子进程残留风险。 | 2026-07-06 |
| D25 | **Claude SDK 用户可见输出只取 `type=result` 的 `result` 字段**：`assistant` / `user` / `system` 消息均视为 Agent SDK 内部过程消息，不进入 Telegram 展示；审批卡仍由 Approval 事件单独展示。该决策对齐官方 Agent SDK 示例中遍历 `query()` 后读取 `message.result` 的用法。 | 2026-07-06 |
| D26 | **`AGENT_IDLE_TIMEOUT_MS` 是已启动 CLI/adapter 的统一空闲回收时间**：默认 5 分钟无输入/输出/审批活动即 stop 并把会话标回 `idle`。其中 `/new` 停旧运行时的旧方案已由 D29 修正为关闭旧 conversation 并经 `SessionClosed` stop adapter。 | 2026-07-06 |
| D27 | **会话复用只看同边界最新记录**：`findActive(userId, cli, cwd)` 只检查该边界下最新一条 conversation；若最新为 `closed/closing`，下一条普通消息必须新建会话，不再回捞更旧的 `idle` 会话。这样 `/close` 后首条消息与 `/new` 后首条消息一样进入新上下文。 | 2026-07-06 |
| D28 | **conversation 持久状态只保留五态**：`idle / starting / running / closing / closed`。审批 `waitingApproval` 只属于 Adapter/Orchestrator 内存态与后续 Audit，不写入 `conversations.status`。 | 2026-07-06 |
| D29 | **`/new` 关闭旧会话而非置 idle**：旧 conversation 进入 `closed` 并停止旧 adapter，新 conversation 初始为 `idle`；第一条普通消息再懒启动 CLI 并转 `starting→running`。 | 2026-07-06 |
| D30 | **`/cwd` 是“关闭当前会话 + 切换目标 cwd”**：`/cwd` 无参数查看当前目标目录；`/cwd <path>` 校验绝对目录、关闭当前会话、更新用户目标 cwd，不创建 conversation，下一条普通消息在新目录新建。 | 2026-07-06 |
| D31 | **当前只支持 `claude` CLI**：`/new [cli] [cwd]` 严格校验，`codex/gemini` 在 Adapter 未接入前返回“不支持”，未知 cli 不再静默当作 cwd。 | 2026-07-06 |
| D32 | **M8/M9 重新切分**：M8 做全局记忆基础；M9 做媒体/文件处理与 OCR。M8 顺序由 D33 细化，M9 媒体分层由 D34 细化。 | 2026-07-06 |
| D33 | **环境快照记忆是 M8 第一子任务**：VPS 运维 AI 必须先知道当前运行环境；M8 拆为 M8-A 环境快照 upsert、M8-B adapter start 注入、M8-C `/remember`、M8-D `/memory`/`/forget`。环境快照包括 OS、shell、cwd、default cwd、hostname、Bun 版本、Node/PowerShell/Bash 信息、可用 CLI 与平台路径风格。 | 2026-07-06 |
| D34 | **M9 媒体理解分层**：Unicode emoji 是文本语义归一化，不走 OCR；Telegram sticker/custom emoji 先解析 metadata（`emoji`、`set_name`、`custom_emoji_id`、`is_animated`、`is_video`、`file_id`），不靠 OCR；OCR 只负责图片/PDF/截图中的文字；动态 sticker 视觉语义属于 Vision/抽帧增强，作为 M9-D 可选能力。 | 2026-07-06 |

---

## 4. 下一步行动（Next Actions）

**M6b — 会话管理命令 & 生产级加固**（当前）：

状态：**M6b 已完成；自动验收与真机复测均通过**。

### 变更清单

**会话管理命令**（`transport/telegram/telegram-transport.ts` + 新增 `core/commands.ts`）：
1. 新增 `/close` —— 关闭当前会话（SessionClosed → db closed → 清理 adapter）
2. 新增 `/new` —— 强制开新会话（旧 closed，新 idle → SessionCreated）
3. 新增 `/status` —— 显示当前会话状态 + id + 存活时长
4. 新增 `/sessions` —— 列出该用户最近 10 条历史会话（状态/日期/cwd）
5. 新增 `/cwd` —— 查看或切换当前用户目标 cwd；切换时关闭当前会话，不创建新会话

**重启映射修复**（`core/session-manager.ts` + `transport/telegram/telegram-transport.ts`）：
6. `findOrCreate` 复用分支发射 `SessionMapped` 事件（D14）
7. Transport 订阅 `SessionMapped` + `SessionCreated` 同一 handler 更新 convChat；订阅 `UserTargetChanged` 更新 `/cwd` 目标

**审批整轮取消**（`core/commands.ts` + `orchestrator.ts` + `cli/base.ts`）：
8. `CLIAdapter` 接口加 `interrupt(): void`
9. `ClaudeSdkAdapter.start` 存 `query` 引用；`interrupt()`→ `query.interrupt()`
10. orchestrator `ApprovalRejected` 订阅调 `adapter.interrupt()` 停止当前 query

**语言偏好**（`transport/telegram/` + `orchestrator.ts` + `cli/base.ts`）：
11. Transport 维持 `userLang: Map<userId, 'zh'|'en'>`；`/lang <zh|en>` 切换；默认 `zh`
12. `CLIAdapter.StartOptions` 加 `systemLanguageHint?: string`
13. orchestrator `ensureAdapter` 查 lang 并注入到 `adapter.start({ systemLanguageHint })`
14. `ClaudeSdkAdapter.start` 将 `systemLanguageHint` 作为首条 system 消息喂入

**后端逻辑**：
15. 新增 `core/commands.ts` 导出 `CommandRouter`——区分系统命令与普通文本
16. `MessageRouter` 处理 `/` 开头消息时先走 `CommandRouter`
17. `main.ts` 装配 CommandRouter→注入 CoreHub/router；`resolveCwd` 在 Composition Root 做真实目录校验

### 验收

- 自动验收：`bun run format` ✅ · `bun run typecheck` ✅ · `bun run lint` ✅ · `bun test` ✅（158 pass / 6 skip / 0 fail）
- 真机复测重点（已完成）：
  ① `/status`→显示完整 conversationId 和目标 cwd → `/close`→会话 closed → 再发消息→新建会话 → `/new`→旧 closed、新 idle
  ② 重启服务后发消息→回复正常落地（SessionMapped 修复）
  ③ 审批点 Reject→整轮停止（不弹第二卡）
  ④ `/lang zh`→中文回复；`/lang en`→英文回复
  ⑤ Windows 路径显示保留反斜杠；thinking / `</think>` 不再出现在 Telegram
  ⑥ 长回复不再触发 `message is too long`；`/status` 显示 Language；`/new [cwd]` 后普通消息进入新 cwd；内部 skill/system-role 文本不再泄露
  ⑦ `ls -la /d/` 等只读 Bash 不弹审批；Markdown 表格不再以管道表原样显示；debug raw JSON 不再输出高频 `thinking_tokens`；Claude Code skill harness 泄露到 text block 时会清洗
  ⑧ 含 Windows 路径的回复仍启用 MarkdownV2（粗体/行内代码正常渲染），路径展示为 `D:/...`
  ⑨ 要求新建/修改文件时，未实际调用工具不得声称已完成
  ⑩ 新开的 Claude SDK 会话复用宿主 Claude CLI 认证来源，但不加载宿主 plugins/skills/hooks/MCP；Ctrl+C/bun watch 重启时等待 adapter.stop 完成
  ⑪ 查询/写入等工具调用不再把 `Bash(...)` / `Write(...)` / 工具返回原文发给 Telegram，只展示最终自然语言结果；审批卡照常显示
  ⑫ `/new` 后旧会话 `closed` 且旧 Claude SDK 运行时经 `SessionClosed` 立即 stop；已启动 CLI/adapter 空闲 `AGENT_IDLE_TIMEOUT_MS`（默认 5 分钟）后自动 stop 并把当前会话标回 `idle`
  ⑬ `/close` 后首条普通消息必须 `SessionCreated`，不得 `SessionMapped` 到更旧 idle；若 Claude Code 宿主 `# Safety/# Memory/# Active background agents` 前缀泄漏到 text block，展示层清洗后只保留最终回复
  ⑭ `/cwd` 无参数只查看目标目录；`/cwd <path>` 校验绝对存在目录，关闭当前会话并切换目标，下一条消息在新 cwd 新建
  ⑮ `/new codex ...` / `/new gemini ...` 在 Adapter 未接入前返回不支持；未知 cli 不得被静默当成 cwd
  ⑯ `hello` 这类首轮回复不得在 TG 展示 `Wait for all results... </system-reminder>`；debug raw result 不打印完整 `result.result`

**M7 — Audit 落地**（M6b 之后）：
1. 审批决议订阅 → AuditRepository.record；不改变 conversation status
2. SessionCreated/SessionClosed → DB 状态同步
3. AuditRepository 全程纪录
4. main.ts 装配

**M8 — 全局记忆基础**（M7 之后）：
- **M8-A 环境快照记忆**：启动时 upsert OS、shell、cwd、default cwd、hostname、Bun 版本、Node/PowerShell/Bash 信息、可用 CLI、平台路径风格等环境事实
- **M8-B 全局记忆注入**：Adapter start 注入环境记忆 + user-level 全局记忆；conversation messages 当前不做完整回放
- **M8-C `/remember <text>`**：写入 user-level 持久记忆；不做隐式猜测抽取
- **M8-D `/memory` / `/forget <id>`**：查看与删除用户记忆

**M9 — 媒体/文件处理 + OCR/Vision**（M8 之后）：
- **M9-A emoji 文本归一化**：识别 Unicode emoji，补充 short name/keywords 作为文本上下文；不走 OCR
- **M9-B Telegram sticker/custom emoji metadata**：解析 `emoji`、`set_name`、`custom_emoji_id`、`is_animated`、`is_video`、`file_id`；第一版不做画面理解
- **M9-C 文件/图片/PDF/Office 解析 + OCR**：Telegram document/photo 入站；PDF/Word/Excel/文本解析；图片和扫描 PDF 走可插拔 OCR，默认开启
- **M9-D Vision 可选增强**：static sticker/thumbnail 可走图片理解；animated/video sticker 后续抽帧再走 Vision，不归入 OCR

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
| 2026-07-05 | **M6b 代码完成（待真机验证）**：新增 Core CommandRouter + `/new` `/close` `/status` `/sessions`；新增 `SessionMapped` 修复重启映射、`CommandReply` 支持无会话命令回复；Telegram 支持 `/lang zh\|en` 并订阅 `SessionMapped`；orchestrator 在拒绝审批时 `interrupt()`，`SessionClosed` 时清理 adapter，启动时注入语言 hint；ConversationRepository 增加 `listRecentByUser`。自动验收：format/typecheck/lint/test 全绿，151 pass / 6 skip / 0 fail |
| 2026-07-05 | **M6b 真机回归修复完成（待复测）**：修复 Windows 路径被 Telegram MarkdownV2 吞反斜杠（含 `\` 内容改纯文本发送）；`thinking` delta 不再展示并清理 `<think>`/`</think>` 标签；普通消息驱动会话状态 `idle→starting→running`，`/status` 不再误报 idle；`/lang` 发 `UserLanguageChanged`，orchestrator 停止该用户现有 adapter，下一轮按新语言 hint 重启；Reject 改为先 `interrupt()` 再 resolve reject，并加强 deny 文案。自动验收：format/typecheck/lint/test 全绿，155 pass / 6 skip / 0 fail |
| 2026-07-05 | **M6b 二轮真机回归修复完成（待复测）**：修复 Telegram `message is too long`（出站分段纯文本发送/编辑，避免长回复卡住）；`/status` 增加 `Language: zh\|en`；明确语言偏好为用户级运行期状态（D17）；`/new [cli] [cwd]` 后 Transport 记住用户当前目标 cli/cwd，后续普通消息进入新 cwd（D18）；加强 SDK 输出提示并清理已知 `<system-role>` / skill-check 泄露文本。自动验收：format/typecheck/lint/test 全绿，158 pass / 6 skip / 0 fail |
| 2026-07-05 | **Claude Agent SDK 原始 JSON 调试开关完成**：新增 `DEBUG_AGENT_SDK_JSON` 配置与 `.env.example` 示例；`main.ts` 向 `ClaudeSdkAdapter` 注入 opt-in raw message logger，开启后控制台打印每条 SDK 返回消息的原始 JSON 字符串；补配置与 adapter 单测。自动验收：format/typecheck/lint/test 全绿，162 pass / 6 skip / 0 fail |
| 2026-07-05 | **M6b 三轮真机回归修复完成（待复测）**：针对 `你好` 触发大量项目检查，增强系统提示并在 adapter 层对简单闲聊禁工具兜底；Bash 审批改为保守只读命令自动放行、写/危险组合仍审批（D20）；Telegram 出站将 GFM 管道表转为可读列表，避免 Markdown 表格原样显示。自动验收：format/typecheck/lint/test 全绿，164 pass / 6 skip / 0 fail |
| 2026-07-05 | **M6b 三轮修正**：撤掉 `你好/hello` 等简单问候字面量禁工具逻辑与兜底回复，避免 adapter 误伤正常模型行为；`DEBUG_AGENT_SDK_JSON` 保留 raw message 调试但过滤高频 `system.thinking_tokens` 事件。自动验收：format/typecheck/lint/test 全绿，164 pass / 6 skip / 0 fail |
| 2026-07-05 | **M6b skill harness 泄露修复**：核对 `@anthropic-ai/claude-agent-sdk` 类型后确认真正 thinking 有结构化 `thinking` block / `SDKThinkingTokensMessage`，本次污染来自 `SDKAssistantMessage.message.content[].type="text"` 内的 Claude Code skill harness 文本；在 `formatOutputDelta` 可见文本层清洗 `IMPORTANT: Skills are loaded...` / `## Skill usage for this turn` 模板，保留后续正文。自动验收：format/typecheck/lint/test 全绿，165 pass / 6 skip / 0 fail |
| 2026-07-06 | **M6b 四轮真机回归修复完成（待复测）**：修复含 Windows 路径时 Telegram 整条消息降级纯文本导致 `**`/反引号不渲染的问题；出站展示层将 `D:\...` 归一为 `D:/...` 后继续走 MarkdownV2，审批卡与降级纯文本同样处理；Claude adapter 追加操作结果护栏，避免未调用 Write/Bash 却声称文件已创建。自动验收：format/typecheck/lint/test 全绿，167 pass / 6 skip / 0 fail |
| 2026-07-06 | **M6b 五轮真机回归修复完成（待复测）**：Claude SDK adapter 默认隔离宿主自定义能力（复用宿主 Claude CLI 认证来源，但不加载 plugins / skills / hooks / 外部 MCP）；`SessionOrchestrator.destroy()` 改 async 并 await adapter.stop，main shutdown 等待完整关闭链路，降低 `bun dev` 终止/重启时子进程残留。自动验收：format/typecheck/lint/test 全绿，169 pass / 6 skip / 0 fail |
| 2026-07-06 | **M6b 六轮真机回归修复完成（待复测）**：修复 Telegram 展示层泄露 Agent SDK 中间协议消息的问题；`formatOutputDelta` 现在只展示 `text`，隐藏 `tool_use`/`tool_result`/`thinking`，避免 `Bash(...)`、`Write(...)`、工具返回原文和最终回答重复出现；补充对应单测并恢复 Claude SDK 默认隔离配置。后续十一路按 D25 修正为 Claude SDK adapter 只发 `type=result` 的 `result` 字段。自动验收：format/typecheck/lint/test 全绿，169 pass / 6 skip / 0 fail |
| 2026-07-06 | **M6b 六轮认证修正**：撤掉 `settingSources: []`，避免切断宿主 Claude CLI 原始认证 token；保留 `skills: []` / `plugins: []` / `strictMcpConfig: true` / disable hooks 的隔离策略。自动验收：format/typecheck/lint/test 全绿，169 pass / 6 skip / 0 fail |
| 2026-07-06 | **M6b 七轮真机回归修复完成（待复测）**：修复 `/new` 只新建会话但不停止旧 Claude SDK 运行时的问题；新增 `SessionRuntimeStopRequested` 事件，旧会话置 `idle` 后 orchestrator stop 旧 adapter；`AGENT_IDLE_TIMEOUT_MS` 作为已启动 CLI/adapter 的统一空闲回收时间注入 orchestrator，默认 5 分钟无活动自动 stop 并把会话标回 `idle`；同步 `.env.example` 与命令 UX/接口契约文档。自动验收：format/typecheck/lint/test 全绿，171 pass / 6 skip / 0 fail |
| 2026-07-06 | **M6b 七轮命名修正**：将误导性的 PTY 专属空闲超时配置正式改名为 `AGENT_IDLE_TIMEOUT_MS`，并在 `.env.example`/PRD/架构/接口契约/命令 UX/实施计划中说明该值表示“已启动 CLI/adapter 空闲超过该时间后自动关闭；conversation 保持 idle，可再次唤醒”。 |
| 2026-07-06 | **M6b 八轮真机回归修复完成（待复测）**：定位 `/close` 后首条消息异常为 `findActive` 回捞更旧 idle 会话（日志中 `ca511e32` closed 后映射到 `efacaf20`）；仓储语义改为只复用同边界最新未关闭会话，最新已 closed/closing 则新建；展示层新增 `# Safety/# Skills/# Memory/# CLAUDE.md/# Active background agents ... </think>` 泄漏清洗。自动验收：format/typecheck/lint/test 全绿，173 pass / 6 skip / 0 fail |
| 2026-07-06 | **M6b 九轮状态/命令语义收口完成（待真机复测）**：按最终拍板重整 conversation 状态与命令契约：持久状态移除 `waitingApproval`；`/new` 关闭旧会话再创建新 `idle`；新增 `/cwd` 关闭当前会话并切换目标目录；`/status` 显示完整 ID；`/new [cli] [cwd]` 严格校验当前仅支持 `claude`；移除已无用途的 `SessionRuntimeStopRequested`；M8/M9 重新切分为全局记忆与文件/OCR。自动验收：format/typecheck/lint/test 全绿，157 pass / 6 skip / 0 fail。 |
| 2026-07-06 | **M6b 十轮 TG system-reminder 泄露修复完成（待真机复测）**：真机发现 `hello` 回复在 TG 展示 `Wait for all results... </system-reminder>`，定位为 Claude Code 内部 system-reminder 尾段进入 assistant text；`formatOutputDelta` 新增完整/缺头 system-reminder 清洗；debug raw JSON 对 `result.result` 做 redaction，避免控制台继续打印内部提示正文。自动验收：format/typecheck/lint/test 全绿，158 pass / 6 skip / 0 fail。 |
| 2026-07-06 | **M6b 十一轮 SDK 输出源修正完成（待真机复测）**：复核官方 Claude Agent SDK 文档与本地类型定义后确认 `SDKResultSuccess.result` 是最终结果字段；Claude SDK adapter 改为忽略 `assistant/user/system` 过程消息，只在 `type=result` 时向 Telegram 发 `result.result`，同时继续走展示层清洗。自动验收：format/typecheck/lint/test 全绿，158 pass / 6 skip / 0 fail。 |
| 2026-07-06 | **M8 顺序收口**：确认“当前系统信息/运行环境注入”没有丢，但从 M8 普通子项提升为 M8-A 第一子任务；M8 明确拆为环境快照 upsert → adapter start 注入 → `/remember` → `/memory`/`/forget`。 |
| 2026-07-06 | **M9 媒体处理收口**：确认 Unicode emoji 可直接文本归一化；Telegram sticker/custom emoji 第一版走 metadata（含 associated emoji 与 sticker 类型），OCR 只处理图片/PDF/截图文字；动态 sticker 视觉语义放入可选 Vision/抽帧增强，不和 OCR 混为一谈。 |
| 2026-07-06 | **M6b 真机复测完成**：用户确认 M6b 所有项目已测过；本阶段关闭，下一步进入 M7 Audit 落地。 |

---

## 6. 开放问题（Open Questions）

> 尚未决策、需要时再定的事项。清空表示当前无悬而未决。

- （暂无）
