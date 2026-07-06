# AGENTS.md — AI CLI Remote Control Hub

> 本文件是编码 Agent 的**宪法**，每个会话自动加载。动手写任何代码前，先读完本文件。
> **然后读 [PROGRESS.md](./PROGRESS.md)** 了解当前进度、已拍板的决策和下一步——这是动态状态真相源，每个会话必读。
> 相关文档：[PRD](./docs/01-PRD.md) · [架构](./docs/02-Architecture.md) · [接口契约](./docs/03-Interface-Contracts.md) · [数据模型](./docs/04-Data-Model.md) · [实施计划](./docs/05-Implementation-Plan.md) · [记忆设计](./docs/06-Memory-Design.md) · [命令 UX](./docs/07-Command-UX.md)

---

## 1. 项目一句话

一个运行于个人 VPS 的**轻量 AI CLI 会话管理器**：通过 Telegram/QQ 等客户端远程控制本地 AI CLI（Codex CLI 等），支持远程对话、Tool Approval、按需启停、跨会话长期记忆。**不是 Agent，不是 IDE，是 Session Manager。**

---

## 2. 技术栈（不要引入未列出的替代品）

| 领域 | 选型 | 备注 |
|---|---|---|
| 运行时 | **Bun** | 用 `bun`，不用 node/npm/pnpm |
| 语言 | **TypeScript**（strict） | 全量类型，禁止 `any`（除非注释说明） |
| 终端劫持 | **node-pty** | 仅 PTY 家族（无 SDK 的 CLI），封装在 `runtime/`；Codex 走 Agent SDK，见 D11 |
| CLI 接入（首选） | **@anthropic-ai/Codex-agent-sdk** | SDK 家族，`ClaudeSdkAdapter` 内部持 `query()`，审批经 `canUseTool` |
| 数据库 | **Postgres** | V1 即用，非 SQLite |
| ORM | **Drizzle** | 唯一 SQL 出口，全在 `repository/`+`storage/` |
| 向量 | **pgvector** | 同库；V1 预留列，V1.5 启用 |
| 嵌入 | **API**（`text-embedding-3-small`） | 不跑本地模型；异步批量 |
| Telegram | **Telegraf** | 封装在 `transport/telegram` |
| QQ | **NapCat + Koishi** | 封装在 `transport/qq` |
| 日志 | **Pino** | 结构化 |
| 校验 | **Zod** | 仅用于 `config/` |
| 守护 | PM2 / systemd | 部署期 |

---

## 3. 铁律：依赖只指向抽象（违反即架构腐化）

```
具体实现 ──implements──▶ 抽象接口(shared/types)
core/ ──depends on──▶ 抽象接口
core/ ──❌禁止──▶ 任何具体实现(telegraf/node-pty/drizzle)
```

### 依赖矩阵（`import` 前对照）

| 模块 | ✅ 允许依赖 | ❌ 禁止依赖 |
|---|---|---|
| `core/` | `event/`, `shared/`, `config/`, 抽象接口 | 任何具体 Transport/Adapter/Storage |
| `transport/*` | `event/`, `shared/`, `config/`, 平台 SDK | `core/` 内部、`storage/` |
| `cli/*` | `event/`, `shared/`, `config/`, `runtime/`, `approval/`, **该 CLI 的 SDK（如 `@anthropic-ai/Codex-agent-sdk`）** | `transport/`, `storage/`, `core/` 内部 |
| `repository/` | `storage/`, `shared/` | `core/`, `transport/` |
| `storage/` | Drizzle, `shared/` | 其它全部业务模块 |
| `audit/` | `event/`, `repository/`, `shared/` | `core/`, `transport/`, `cli/`, `runtime/`, `storage/` |
| `memory/` | `event/`, `repository/`, `shared/`, `config/` | `core/`, `transport/` |
| `config/` | `process.env`（**全局唯一**）, Zod | 无（叶子） |
| `shared/` | 无 | 一切业务模块 |

> 只有 **Composition Root（`src/main.ts`）** 允许 import 具体实现并装配。运行期各模块只面向接口。

---

## 4. 目录职责

```text
src/
├── main.ts       # Composition Root：唯一装配具体实现的地方
├── core/         # 核心调度、Session 状态机、路由（无 SQL / 无 SDK / 无 PTY 字节流）
├── event/        # Event Bus + EventMap 类型
├── config/       # 唯一读 process.env 的地方（Zod 校验，fail-fast）
├── transport/    # 客户端接入 (telegram, qq, websocket)
├── cli/          # CLI 适配器 (base, Codex=SDK 家族)；语义接缝 CLIAdapter，两家族同实现
├── runtime/      # PTY 家族字节容器 (nodepty)；SDK 家族不经此层
├── approval/     # PTY 家族审批 scraping（正则）；SDK 家族经 canUseTool，无需
├── repository/   # 数据抽象接口 + Drizzle 实现
├── storage/      # Postgres/Drizzle 连接、schema、迁移 (pgvector)
├── audit/        # 审批审计：订阅审批事件，写入 AuditRepository
├── memory/       # 长期记忆：嵌入、召回、摘要、遗忘
├── logger/       # Pino 全局日志（订阅全部事件）
└── shared/       # 全局类型与工具函数（叶子）
```

---

## 5. 编码规范（AI 每次落笔遵守）

1. **配置**：任何环境变量只经 `config/` 的强类型 `AppConfig` 读取。**禁止在其它任何文件出现 `process.env`。**
2. **SQL**：任何数据库操作只经 `repository/` 的方法。**Core 与业务模块禁止出现 SQL/Drizzle 查询。**
3. **通信**：模块间不直接相互调用，**一律通过 Event Bus 发布/订阅**（`bus.emit` / `bus.on`）。事件与 payload 以 [03-契约](./docs/03-Interface-Contracts.md) 的 `EventMap` 为准。
4. **契约优先**：实现任何 Transport/Adapter/Repository 前，先看 03 的接口定义，严格实现，不擅自改签名。
5. **状态机**：Session 状态流转只走 [02-架构 §5](./docs/02-Architecture.md) 定义的合法迁移；非法迁移应抛错。
6. **运行时 ≠ 会话**：CLI/adapter 空闲超时只关闭运行时、会话转 `idle`；`closed` 只由 `/close`、`/new`、`/cwd <path>` 或归档触发。
7. **错误处理**：可预期错误发 `ErrorOccurred` 事件 + 结构化日志；不吞异常，不裸 `console.log`（用 Pino）。
8. **异步不阻塞主链路**：记忆嵌入、摘要等后台任务失败重试，**绝不阻塞对话收发**。
9. **命名**：接口 `PascalCase`；事件 `PascalCase`（如 `MessageReceived`）；文件 `kebab-case.ts`；类型集中在 `shared/types`。
10. **测试**：难测部件（PTY、事件流、审批注入）用 mock Runtime + 事件断言，见 [08-Testing](./docs/08-Testing-Strategy.md)（若存在）。
11. **维护进度（强制对齐）**：**每完成一个阶段性任务（里程碑/子任务）或做出关键决策，必须立即对齐 [PROGRESS.md](./PROGRESS.md)**（里程碑状态、决策日志、会话 Changelog、下一步）。这是跨会话不漂移的关键——下个会话靠它接续。**未对齐 PROGRESS.md 不算完成本阶段。**
12. **禁止自动提交 Git**：**每次写完功能/改动后，禁止自动 `git commit` / `git push`，除非用户明确下达提交指令。** 完成后只汇报改了什么，等待用户指令再提交。
13. **Import 路径优先用 barrel export 简写**：目录有 `index.ts` 时优先写 `'../shared'` 而非 `'../shared/types/common'`，`'../repository'` 而非 `'../repository/types'`。若 barrel 未 re-export 目标类型，仍用完整路径。
14. **写完必格式化**：**每次写完/改完代码，必须执行 `bun run format`**（Prettier）再进入验收（typecheck/lint/test）。提交前代码须已格式化，`bun run format:check` 应通过。
15. **Windows 大小写陷阱**：本仓库在 Windows 上工作，文件名大小写不敏感。**禁止创建 `progress.md` / `process.md` 等会与 [PROGRESS.md](./PROGRESS.md) 混淆或碰撞的临时记录文件。** 若确需临时过程记录，追加到 `PROGRESS.md` 的明确 `临时备注/TODO` 小段，并在开发完毕、提交前删除该临时段。

---

## 6. 常用命令

```bash
bun install                 # 安装依赖
bun run dev                 # 本地启动（watch）
bun run start               # 生产启动
bun test                    # 跑测试
bun run db:generate         # drizzle-kit 生成迁移
bun run db:migrate          # 应用迁移
bun run typecheck           # tsc --noEmit
bun run lint                # 依赖矩阵 + 风格校验
```

> 具体脚本以 `package.json` 为准；缺失时补齐而非绕过。

---

## 7. Never（做了就是错）

- ❌ 在 `config/` 之外读 `process.env`
- ❌ 在 `repository/` 之外写 SQL / Drizzle 查询
- ❌ 让 `core/` import 任何具体 Transport/Adapter/Storage
- ❌ 模块间直接函数调用替代事件（除注入的接口）
- ❌ 用 SQLite / npm / node（本项目是 Postgres / bun）
- ❌ 本地跑嵌入模型（一律走 API）
- ❌ 把"杀进程"当成"关会话"
- ❌ 让审批/记忆的后台逻辑阻塞对话主链路
- ❌ 非白名单用户的请求进入 Core（必须在 Transport 层丢弃）
- ❌ 未经用户明确指令就 `git commit` / `git push`
- ❌ 完成阶段性任务后不对齐 PROGRESS.md

---

## 8. 扩展新能力（零侵入 Core）

- **新增 CLI**：在 `cli/` 实现语义接缝 `CLIAdapter`，`main.ts` 注册。有 Agent SDK 的走 SDK 家族（内部持 SDK 句柄，审批经 `canUseTool`，无需 `approval/`）；无 SDK 的走 PTY 家族（持 `PtyRuntime` + 在 `approval/` 加 `ApprovalDetector` scraping）。详见 [02 §3.4](./docs/02-Architecture.md) 与决策 D11。
- **新增客户端**：在 `transport/` 实现 `Transport`，`main.ts` 注册。
- **新增记忆能力**：在 `memory/` 订阅事件 + 扩展 `MemoryRepository`。

以上均**不改 `core/`**。若你发现必须改 Core 才能加功能，先停下——大概率是设计或分层出了问题，回看架构文档。
