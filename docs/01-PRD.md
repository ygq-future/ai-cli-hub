# 项目需求文档（PRD）- AI CLI Remote Control Hub（V2）

## 1. 项目定位

**AI CLI Remote Control Hub** 是一个运行于个人 VPS 或本地服务器上的轻量级 AI CLI 远程控制中心。
系统通过 Telegram、QQ、Web 等客户端远程控制本地 AI CLI（如 Claude CLI、Codex CLI、OpenCode CLI 等），实现远程对话、文件编辑、Shell 操作、Tool Approval 以及长期会话管理等功能。

> **核心定义**：本项目不是 AI Agent，也不是 IDE，而是一个**极度轻量、可扩展、安全、稳定的 AI CLI Session Manager（会话管理器）**。

---

## 2. 设计原则与架构思想

整个系统严格遵循**“高内聚、低耦合、插件化、事件驱动”**的设计哲学：

* **全栈运行**：基于 Bun + TypeScript。
* **Core 无平台依赖**：核心调度层（Core）永远不感知具体的 Transport（如 Telegram/QQ）、具体的 CLI 工具（如 Claude/node-pty）以及具体的底层数据库（如 Postgres）。
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
* **CLI Adapter**：所有 CLI 工具必须实现统一的 `BaseCLIAdapter` 接口（包含 `start`, `stop`, `sendInput`, `interrupt`, `resize`, `getState`, `onData` 等）。V1 提供 `ClaudeCLIAdapter`。
* **CLI Runtime**：Adapter 的底层运行容器（如 `node-pty` 或官方 SDK）。对 Core 完全透明，未来可无缝替换。
* **Approval Detector**：审批检测逻辑由各 Adapter 自行实现（如正则提取 `[Y/n]` 或解析 SDK Tool Call），最终对外抛出统一的 `ApprovalEvent`。

### 3.5 Message Aggregator (消息聚合器)
在 PTY 输出与 Transport 发送之间增加的缓冲过滤层。
* **职责**：实现 Buffer、Debounce、Throttle、Flush、Markdown 合并及消息拆分（应对长文本）。防止高频输出触发平台（如 Telegram）的 Edit 频率限制。

### 3.6 Repository & Storage (存储与持久化)
* **Repository 模式**：提供 `ConversationRepository`, `MessageRepository`, `AuditRepository`, `MemoryRepository` 等，Core 永远不直接写 SQL。
* **Storage**：V1 直接采用 **Postgres + Drizzle ORM**（一次定库，避免二次迁移）；长期记忆的向量能力由 `pgvector` 扩展同库承载，V1.5 启用（详见架构文档 §7）。

### 3.7 Config Module (全局配置)
* 全项目**唯一**允许读取系统环境变量的模块，禁止 `process.env` 散落各处。统一管理 Bot Token、白名单、文件路径、超时时间等，并提供强类型校验（Zod）。

---

## 4. 生命周期管理

### 4.1 Session 生命周期
Session 保存会话元数据（ID、User、Platform、CLI Type、cwd、Status 等），与底层 PTY 进程解耦。
* **状态流转**：`Idle` → `Starting` → `Running` → `WaitingApproval` → `Running` → `Idle`（进程回收）/ `Closing` → `Closed`（归档）。
* **关键区分**：`进程回收` ≠ `会话关闭`。进程空闲超时仅销毁 PTY、会话转 `Idle` 可随时唤醒；只有 `/close` 或长期无活动才进入 `Closed` 并生成摘要。
* **会话边界（何时新建会话）**：以 `(user_id, cli, cwd)` 三元组定位活跃会话，默认复用；`/new` 强制开新；`/close` 或超过 `SESSION_ARCHIVE_DAYS` 天无活动自动归档。不同项目目录（cwd）天然分属不同会话，记忆据此按项目隔离。

### 4.2 CLI 进程生命周期 (按需启停)
`收到消息` → `若无 Runtime 则启动` → `建立 Adapter 与 Session 绑定` → `持续交互` → `超出 Idle Timeout` → `销毁 Runtime 进程释放内存 (保留 Session 状态)` → `等待下次唤醒`。

---

## 5. 安全体系设计

* **硬编码白名单**：启动时加载允许访问的 User ID（TG/QQ/Web 等）。非白名单请求在 Transport 层直接静默丢弃。
* **交互式 Approval 机制 (Human-in-the-loop)**：
  * 检测到危险操作，Session 进入 `WaitingApproval`。
  * 客户端收到 Markdown 文本及内联按钮 `[Approve]` / `[Reject]`。
  * 点击同意注入 `y\r`；点击拒绝注入 `n\r` 或发送 `Ctrl+C` 中断信号。
* **永久审计日志 (Audit Log)**：强制记录每一次触发命令审批的时间、操作人、内容及最终决策结果。

---

## 6. 数据库设计 (V1)

| 表名 | 字段描述 | 用途 |
|---|---|---|
| `conversations` | `id`, `platform`, `user_id`, `cli`, `cwd`, `status`, `created_at`, `updated_at` | 记录会话的全局状态与生命周期；`cwd` 决定会话边界 |
| `messages` | `id`, `conversation_id`, `role`, `content`, `created_at` | 存储完整对话记录，用于恢复上下文 |
| `audit_logs` | `id`, `conversation_id`, `command`, `action`, `operator`, `created_at` | 存储敏感指令的审批操作记录 |
| `memories` | `id`, `user_id`, `conversation_id`(可空), `type`, `content`, `embedding`, `source_message_id`, `importance`, `access_count`, `last_accessed_at`, `tag`, `created_at` | 长期记忆：`conversation_id` 为空即 user-level 画像/偏好，填值即 conversation-level 情节摘要；`embedding` 列 V1 预留、V1.5 启用 pgvector |

> **向量分阶段**：V1 建表即预留 `embedding` 列（可 NULL），仅用关系 + 全文检索（FTS）做跨会话摘要回放；V1.5 启用 `pgvector` + HNSW 索引填充向量，接入语义召回。详见架构文档 §7。

---

## 7. 目录与插件结构

```text
src/
├── core/         # 核心调度、Session 管理、状态机
├── event/        # Event Bus 与事件类型定义
├── config/       # 统一环境变量配置解析 (Zod)
├── transport/    # 客户端接入层 (telegram, qq, websocket)
├── cli/          # 命令行适配器 (base, claude, codex)
├── runtime/      # 进程运行容器 (nodepty, sdk)
├── approval/     # 各类 CLI 的审批正则与拦截逻辑
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
* **终端劫持**：node-pty
* **数据库/ORM**：Postgres + Drizzle ORM（V1.5 启用 pgvector 向量能力）
* **长期记忆**：API 嵌入模型（`text-embedding-3-small`）+ pgvector 语义召回
* **消息框架**：Telegraf (Telegram) / NapCat+Koishi (QQ)
* **日志/校验**：Pino / Zod
* **进程守护**：PM2 或 systemd

**V1 必须交付的功能边界：**
✅ Bun + TypeScript 基础架构
✅ Postgres + Drizzle 数据库设计与 Repository 封装（`embedding` 列预留）
✅ Event Bus 模块间通信机制
✅ Config Module 统一配置中心
✅ Telegram Bot Transport 接入
✅ Claude CLI Adapter + node-pty Runtime 劫持
✅ 基于状态机的 Session 生命周期管理
✅ Message Aggregator 流式聚合渲染
✅ Approval Flow (Markdown卡片与回调拦截)
✅ 永久 Audit Log 审计记录机制
✅ 会话边界管理（cwd 复用 / `/new` / `/close` / 自动归档）
✅ 长期记忆基础：跨会话摘要回放（关系 + FTS，`embedding` 列预留待 V1.5 启用向量）

---

## 9. 演进路线

得益于当前高度解耦的插件化架构，未来新增任何能力均**无需修改 Core 的业务逻辑**：
* **新增 CLI**：直接新增 `CodexAdapter`、`GeminiCLIAdapter`。
* **新增客户端**：直接实现 `HTTPTransport` 或 `MCPTransport` 注册入网关。
* **新增能力**：如引入 `pgvector` 实现 RAG 语义召回，只需扩展 `MemoryRepository` 并监听 `MessageGenerated` 事件进行后台嵌入与分析，零侵入核心对话流程。