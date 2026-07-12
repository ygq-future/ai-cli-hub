# 项目需求文档（PRD）- AI CLI Remote Control Hub（V2）

## 1. 项目定位

**AI CLI Remote Control Hub** 是一个运行于个人 VPS 或本地服务器上的轻量级 AI CLI 远程控制中心。
系统通过 Telegram、QQ、Web 等客户端远程控制本地 AI CLI（如 Claude CLI、Codex CLI、OpenCode CLI 等），实现远程对话、文件编辑、Shell 操作、Tool Approval 以及长期会话管理等功能。

> **核心定义**：本项目不是 AI Agent，也不是 IDE，而是一个**极度轻量、可扩展、安全、稳定的 AI CLI Session Manager（会话管理器）**。

---

## 2. 设计原则与架构思想

整个系统严格遵循**“高内聚、低耦合、插件化、事件驱动”**的设计哲学：

* **全栈运行**：基于 Bun + TypeScript。
* **Core 无平台依赖**：核心调度层（Core）永远不感知具体的 Transport（如 Telegram/QQ）、具体的 CLI 适配实现（如 claude-agent-sdk / node-pty）以及具体的底层数据库（如 Postgres）。
* **四大隔离模式**：
  * `Adapter 模式`：隔离底层 CLI 工具差异。
  * `Transport 模式`：隔离不同客户端接入协议差异。
  * `Repository 模式`：隔离数据库持久化层操作差异。
  * `Event 驱动`：解耦各业务模块间的直接调用。
* **统一生命周期**：Session 状态由统一的状态机管理。

### 总体架构数据流向
`Client (Telegram/QQ/Web)` ↔ `Transport Layer` ↔ `Core Hub (via Event Bus)` ↔ `CLI Adapter` ↔ `CLI Runtime` ↔ `Target CLI`
*(持久化操作由各模块通过 `Event Bus` 或直接调用 `Storage Repository` 完成，最终落盘至 `Postgres`)*

---

## 3. 核心模块划分

### 3.1 Transport Layer (接入层)
负责所有外部客户端的接入。Core 不关心消息来源，统一遵循 Transport 接口。
* **支持范围**：V1 支持 Telegram、QQ；未来支持 WebSocket、HTTP API、MCP 等。
* **统一接口定义**：实现 `sendMessage()`, `editMessage()`, `deleteMessage()`, `sendApproval()` 等标准方法。

### 3.2 Core Hub (核心调度)
系统的唯一大脑与调度中心。
* **职责**：负责 Session 生命周期管理、用户鉴权、权限管理、消息路由、Event 发布、Adapter 调度及 Repository 调用。
* **边界**：**绝不**处理 API 请求细节、不写具体 CLI 控制逻辑、不写任何 SQL 语句。

### 3.3 Event Bus (事件总线)
系统模块间通信的唯一枢纽，所有模块通过监听事件来完成自身业务逻辑，避免模块间的强耦合。
* **核心事件流**：`SessionCreated` / `SessionClosed` / `MessageReceived` / `MessageGenerated` / `ApprovalRequested` / `ApprovalApproved` / `ApprovalRejected` / `PTYStarted` / `PTYExited` / `MemoryUpdated` / `ErrorOccurred`。
* **应用示例**：Logger 监听全部事件；Storage 监听 `Message*` 事件进行落盘，均无需修改 Core。

### 3.4 CLI Adapter & Runtime (命令行适配与运行层)
* **CLI Adapter（语义接缝）**：所有 CLI 工具实现统一的语义化 `CLIAdapter` 接口（`start` / `stop` / `interrupt` / `sendUserInput` / `onOutput` / `onApprovalRequest` / `resolveApproval` / `onExit` / `getState`）。它说领域语义（一轮输入 / 流式输出 / 审批请求+决定 / 生命周期），与「字节还是结构化」无关。当前提供 **`ClaudeSdkAdapter`（走 `@anthropic-ai/claude-agent-sdk`）** 与 **`OpenCodeSdkAdapter`（走 `@opencode-ai/sdk`，需本机 `opencode` CLI）**。
* **两个家族**：**SDK 家族（首选）** 内部持 `query()` 句柄，输出/审批结构化（`SDKMessage` + `canUseTool`），无需 scraping；**PTY 家族（无 SDK 的 CLI 备用）** 内部持 `PtyRuntime`（node-pty 字节容器）+ `ApprovalDetector`（正则 scraping）。接缝在 Adapter、不在 Runtime——两形态的差异封在 Adapter 内部（详见 [02 §3.4](./02-Architecture.md) 与决策 D11）。
* **Approval**：SDK 家族经 `canUseTool` 结构化直达（拿到工具名+参数）；PTY 家族由 per-CLI `ApprovalDetector` 从字节流 scraping。两者最终统一发 `ApprovalRequested`。

### 3.5 Message Aggregator (消息聚合器)
在 PTY 输出与 Transport 发送之间增加的缓冲过滤层。
* **职责**：实现 Buffer、Debounce、Throttle、Flush、Markdown 合并及消息拆分（应对长文本）。防止高频输出触发平台（如 Telegram）的 Edit 频率限制。

### 3.6 Repository & Storage (存储与持久化)
* **Repository 模式**：提供 `ConversationRepository`, `MessageRepository`, `AuditRepository`, `MemoryRepository` 等，Core 永远不直接写 SQL。
* **Storage**：V1 直接采用 **Postgres + Drizzle ORM**（一次定库，避免二次迁移）；长期记忆的向量能力由 `pgvector` 扩展同库承载，V1.5 启用（详见架构文档 §7）。

### 3.7 Config Module (全局配置)
* 从 `settings.json` 读取 Bot Token、白名单、数据库、文件路径和超时等业务配置，并提供强类型 Zod 校验；仅允许 config 模块把代理值写回 `process.env` 供底层网络库继承。

---

## 4. 生命周期管理

### 4.1 Session 生命周期
Session 保存会话元数据（ID、User、Platform、CLI Type、cwd、Status 等），与底层 PTY 进程解耦。
* **状态双机分离（D28）**：**持久化状态**（`conversations.status`，落库）仅 5 态：`idle | starting | running | closing | closed`；**运行期状态**（`AdapterState`，仅 adapter 内存态、永不落库）为 `stopped | starting | running | waitingApproval`。审批是**实时运行期概念**——针对内存中挂起的 `canUseTool` promise，进程死则失效、无法从库恢复，故 `waitingApproval` 只活在运行期，不写入 `conversations.status`。
* **状态流转**：持久化 `idle` → `starting` → `running` → `idle`（运行时回收）/ `closing` → `closed`（归档）。审批期间持久化状态仍为 `running`，仅运行期 `AdapterState` 短暂进入 `waitingApproval`。
* **重启对账**：进程重启后无任何内存 adapter，启动时对账——DB 残留的 `starting`/`running` 复位为 `idle`，未完成的 `closing` 收尾为 `closed`。
* **关键区分**：`运行时回收` ≠ `会话关闭`。已启动的 CLI/adapter 空闲超时仅关闭运行时、会话转 `idle` 可随时唤醒；`/close`、`/new`、`/cwd <path>` 或长期无活动才进入 `closed` 并生成摘要。
* **会话边界与 `/new`/`/cwd`**：会话 scope = `(platform, user_id)`，每个 scope 只保留一条未关闭会话（`idle/starting/running/closing`）；CLI 与 cwd 是该会话的当前目标属性，不再划分独立会话。Transport 重启丢失内存目标时，普通消息和 `/status` 会在同 scope 回查最新可复用会话并恢复 `cli/cwd`。`/new` 新建前只关闭同 scope 的非 `closed` 历史会话；`/cwd <path>` 关闭当前会话并切换目标 cwd，不创建 conversation。唤醒 `idle` = 复用同一 DB 行 + 全新 Claude query，user message 前缀携带最近 `RECENT_CONTEXT_LIMIT` 条历史消息；跨会话连续性由记忆子系统承担。

### 4.2 CLI 进程生命周期 (按需启停)
`收到消息` → `若无 Runtime 则启动` → `建立 Adapter 与 Session 绑定` → `持续交互` → `超出 Idle Timeout` → `销毁 Runtime 进程释放内存 (保留 Session 状态)` → `等待下次唤醒`。

---

## 5. 安全体系设计

* **硬编码白名单**：启动时加载允许访问的 User ID（TG/QQ/Web 等）。非白名单请求在 Transport 层直接静默丢弃。
* **交互式 Approval 机制 (Human-in-the-loop)**：
  * 检测到危险操作，Adapter 进入运行期 `waitingApproval`，conversation 持久状态保持 `running`。
  * 客户端收到 Markdown 文本及内联按钮 `[Approve]` / `[Reject]`。
  * 点击同意通过 `resolveApproval(..., 'approve')` 继续；点击拒绝先 `interrupt()` 再 `resolveApproval(..., 'reject')` 停止当前轮。
* **永久审计日志 (Audit Log)**：强制记录每一次触发命令审批的时间、操作人、内容及最终决策结果。

---

## 6. 数据库设计 (V1)

| 表名 | 字段描述 | 用途 |
|---|---|---|
| `conversations` | `id`, `platform`, `user_id`, `cli`, `cwd`, `status`, `created_at`, `updated_at` | 记录 `(platform,user_id)` scope 的会话状态与生命周期；`cli/cwd` 是当前目标 |
| `messages` | `id`, `conversation_id`, `role`, `content`, `created_at` | 存储完整对话记录，用于历史查看、审计与后续摘要；当前不做完整上下文回放 |
| `audit_logs` | `id`, `conversation_id`, `command`, `action`, `operator`, `created_at` | 存储敏感指令的审批操作记录 |
| `memories` | `id`, `namespace`, `conversation_id`(可空), `type`, `content`, `embedding`, `source_message_id`, `importance`, `access_count`, `last_accessed_at`, `tag`, `created_at` | 长期记忆：默认 `namespace='global'` 是当前实例共享记忆池；`conversation_id` 为空即全局事实/偏好/环境，填值即会话产出的情节摘要；`embedding` 列 V1 预留、V1.5 启用 pgvector |

> **向量分阶段**：V1 建表即预留 `embedding` 列（可 NULL），先做实例级命令式全局记忆与环境事实全量注入；V1.5 启用 `pgvector` + HNSW 索引填充向量，接入语义召回。详见架构文档 §7。

---

## 7. 目录与插件结构

```text
src/
├── core/         # 核心调度、Session 管理、状态机
├── event/        # Event Bus 与事件类型定义
├── config/       # 统一环境变量配置解析 (Zod)
├── transport/    # 客户端接入层 (telegram, qq, websocket)
├── cli/          # 命令行适配器 (base, claude=SDK 家族, codex)
├── runtime/      # PTY 家族字节容器 (nodepty)；SDK 家族不经此层
├── approval/     # PTY 家族审批 scraping（SDK 家族经 canUseTool，无需）
├── repository/   # 数据库抽象操作接口
├── storage/      # Postgres/Drizzle 具体连接与建表逻辑 (pgvector)
├── memory/       # 长期记忆与向量化存储 (预留)
├── logger/       # 全局日志记录
└── shared/       # 全局工具函数与类型定义
```

---

## 8. V1 交付范围与技术选型

**最终确定的技术栈：**
* **运行环境**：Bun
* **开发语言**：TypeScript
* **CLI 接入**：Agent SDK 优先（`@anthropic-ai/claude-agent-sdk`）；node-pty 仅用于无 SDK 的 CLI（PTY 家族）
* **数据库/ORM**：Postgres + Drizzle ORM（V1.5 启用 pgvector 向量能力）
* **长期记忆**：API 嵌入模型（默认 `BAAI/bge-m3`，1024 维）+ pgvector 语义召回
* **消息接入**：Telegraf (Telegram) / 腾讯官方 QQ Bot Gateway + HTTP API（`ws` + Bun `fetch`）
* **日志/校验**：Pino / Zod
* **进程守护**：PM2 或 systemd

**V1 必须交付的功能边界：**
✅ Bun + TypeScript 基础架构
✅ Postgres + Drizzle 数据库设计与 Repository 封装（`embedding` 列预留）
✅ Event Bus 模块间通信机制
✅ Config Module 统一配置中心
✅ Telegram Bot Transport 接入
✅ 腾讯官方 QQ Bot C2C Transport 接入（文本、官方流式消息、审批回调键盘）
✅ Claude Adapter（`@anthropic-ai/claude-agent-sdk`，SDK 家族）与 opencode Adapter（`@opencode-ai/sdk`，SDK 家族）
✅ 基于状态机的 Session 生命周期管理
✅ Message Aggregator 流式聚合渲染
✅ Approval Flow (Markdown卡片与回调拦截)
✅ 永久 Audit Log 审计记录机制
✅ 会话边界管理（cwd 目标切换 / `/new` / `/close` / `/cwd` / 自动归档）
✅ 长期记忆基础：实例级命令式全局记忆 + 环境记忆注入（`embedding` 列预留待 V1.5 启用向量）
✅ 媒体/文件基础：emoji 文本归一化、sticker metadata、Telegram 可下载媒体入站保存、非图片文件懒加载 metadata/local_path、按需文本/PDF/DOCX/XLS/XLSX 解析能力、图片 Light OCR HTTP provider 接入（音视频转写与 Vision 后续迭代）

---

## 9. 演进路线

得益于当前高度解耦的插件化架构，未来新增任何能力均**无需修改 Core 的业务逻辑**：
* **新增 CLI**：直接新增 `CodexAdapter`、`GeminiCLIAdapter`。
* **新增客户端**：直接实现 `HTTPTransport` 或 `MCPTransport` 注册入网关。
* **新增能力**：如引入 `pgvector` 实现 RAG 语义召回，只需扩展 `MemoryRepository` 并监听 `MessageGenerated` 事件进行后台嵌入与分析，零侵入核心对话流程。
