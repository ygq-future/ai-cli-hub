# 系统架构文档 - AI CLI Remote Control Hub（V1）

> 本文档基于 [01-PRD.md](./01-PRD.md) 编写，将产品需求转化为可落地的技术架构。
> 阅读对象：核心开发者、Adapter/Transport 插件贡献者、Code Review 人员。

---

## 1. 架构总览

### 1.1 架构目标

| 目标 | 落地手段 |
|---|---|
| **低耦合** | Core 只依赖抽象接口（`Transport` / `CLIAdapter` / `Repository`），永不依赖具体实现 |
| **可扩展** | 新增 CLI / 客户端 / 存储 = 新增一个实现类并注册，Core 零改动 |
| **事件驱动** | 模块间不直接相互调用，一律通过 Event Bus 发布/订阅 |
| **安全可控** | 白名单前置拦截 + Human-in-the-loop 审批 + 永久审计 |
| **资源节约** | CLI/adapter 按需启停，空闲回收，Session 元数据与运行时解耦 |
| **智能记忆** | 会话 / 进程双层解耦，长期记忆归属实例级 `namespace`，不按 Transport `user_id` 隔离；事件驱动异步嵌入 + 向量召回，零侵入对话主链路 |

### 1.2 分层视图

系统自上而下分为 **接入层 / 调度层 / 执行层 / 持久层**，Event Bus 与 Config 为横向贯穿的基础设施。

```mermaid
flowchart TB
    subgraph Client["客户端"]
        TG[Telegram]
        QQ[QQ]
        WEB[Web / WS]
    end

    subgraph Transport["接入层 Transport Layer"]
        TGT[TelegramTransport]
        QQT[QQTransport]
        WST[WebSocketTransport]
    end

    subgraph Core["调度层 Core Hub"]
        SM[SessionManager<br/>状态机]
        AUTH[Auth / 白名单]
        ROUTER[MessageRouter]
        AGG[MessageAggregator]
    end

    subgraph Exec["执行层 CLI Adapter（语义接缝）"]
        CA[ClaudeSdkAdapter<br/>SDK 家族·首选]
        RT[PtyRuntime + ApprovalDetector<br/>PTY 家族·无 SDK 时备用]
    end

    subgraph Infra["基础设施（横向）"]
        BUS[[Event Bus]]
        CFG[Config Module]
        LOG[Logger]
    end

    subgraph Persist["持久层 Repository & Storage"]
        REPO[Repositories]
        MEM[Memory 模块<br/>嵌入 / 召回]
        DB[(Postgres + pgvector<br/>via Drizzle)]
    end

    EMB[[嵌入 API<br/>BAAI/bge-m3]]

    Client <--> Transport
    Transport <--> Core
    Core <--> Exec
    Exec <--> Target[Target CLI 进程]

    Core -.发布/订阅.-> BUS
    Transport -.发布/订阅.-> BUS
    Exec -.发布/订阅.-> BUS
    Persist -.订阅.-> BUS
    LOG -.订阅全部.-> BUS
    MEM -.订阅 MessageGenerated.-> BUS
    MEM -->|异步嵌入| EMB
    REPO --> DB
    MEM --> REPO
    CFG -.注入.-> Core & Transport & Exec
```

> **关键约束**：箭头方向即依赖方向。Core 只向下依赖抽象接口；具体实现（Telegraf、node-pty、Drizzle）永远不出现在 Core 的 import 中。

---

## 2. 依赖规则与模块边界

架构的可维护性由一条铁律保证：**依赖只能指向抽象，不能指向实现**。

```mermaid
flowchart LR
    Concrete["具体实现<br/>(telegram/ nodepty/ storage)"] -->|implements| Abstract["抽象接口<br/>(shared/types)"]
    Core["core/"] -->|depends on| Abstract
    Core -.->|禁止 ❌| Concrete
```

### 2.1 模块依赖矩阵

| 模块 | 允许依赖 | 禁止依赖 |
|---|---|---|
| `core/` | `event/`, `shared/`, `config/`, 抽象接口 | 任何具体 Transport / Adapter / Storage 实现 |
| `transport/telegram` | `event/`, `shared/`, `config/`, Telegraf | `core/` 内部实现、`storage/` |
| `cli/claude` | `event/`, `shared/`, `config/`, `runtime/`, `approval/`, **该 CLI 的 SDK（如 `@anthropic-ai/claude-agent-sdk`）** | `transport/`, `storage/`, `core/` 内部 |
| `repository/` | `storage/`, `shared/` | `core/`, `transport/` |
| `storage/` | Drizzle, `shared/` | 其它全部业务模块 |
| `config/` | `process.env`（**全局唯一**）、Zod | 无（叶子模块） |
| `shared/` | 无（纯类型与工具） | 一切业务模块 |

> **落地验证**：可通过 ESLint `no-restricted-imports` 或 `dependency-cruiser` 在 CI 中强制校验上述矩阵，防止架构腐化。

---

## 3. 核心组件设计

### 3.1 Transport Layer（接入层）

**职责**：屏蔽不同客户端协议差异，向 Core 提供统一的收发消息能力。

```typescript
interface Transport {
  readonly platform: Platform;              // 'telegram' | 'qq' | 'websocket'
  start(): Promise<void>;
  stop(): Promise<void>;

  sendMessage(chatId: string, content: string): Promise<MessageRef>;
  editMessage(ref: MessageRef, content: string): Promise<void>;
  deleteMessage(ref: MessageRef): Promise<void>;
  sendApproval(chatId: string, card: ApprovalCard): Promise<MessageRef>;
}
```

- **入站方向**：收到客户端消息 → 执行白名单校验 → 发布 `MessageReceived` 事件。**非白名单请求在此层静默丢弃，绝不进入 Core。**
- **出站方向**：订阅 `MessageGenerated` / `ApprovalRequested` 事件 → 调用平台 SDK 发送。
- `MessageRef` 抽象了 Telegram `message_id`、QQ 消息序号等平台差异，供后续 `editMessage` 定位（流式渲染的关键）。

### 3.2 Core Hub（核心调度）

系统唯一大脑，本身**无状态机业务外的具体逻辑**，只做编排：

- **SessionManager**：维护 Session 生命周期状态机（见 §5）。
- **Auth**：加载 Config 中的白名单，提供二次鉴权（Transport 已做前置拦截，此处为纵深防御）。
- **MessageRouter**：将 `MessageReceived` 路由到对应 Session，必要时触发 Adapter 启动。
- **边界红线**：不写 SQL、不调平台 SDK、不写 PTY 控制字节流，全部下沉到对应层。

### 3.3 Event Bus（事件总线）

模块间通信的**唯一枢纽**。V1 采用进程内类型安全的 EventEmitter 封装。

```typescript
interface EventBus {
  emit<E extends keyof EventMap>(type: E, payload: EventMap[E]): void;
  on<E extends keyof EventMap>(type: E, handler: (p: EventMap[E]) => void): Unsubscribe;
}
```

**核心事件目录**：

| 事件 | 发布者 | 主要订阅者 | 语义 |
|---|---|---|---|
| `SessionCreated` | Core | Logger / Storage | 会话元数据创建 |
| `SessionClosed` | Core | Runtime / Storage | 会话终止，触发进程回收 |
| `UserTargetChanged` | Core(CommandRouter) | Transport | `/cwd` 等只切换用户目标 cli/cwd，不创建 conversation |
| `MessageReceived` | Transport | Core(Router) | 用户输入到达 |
| `MessageGenerated` | Aggregator | Transport / Memory | CLI 输出聚合完成，待渲染 |
| `ApprovalRequested` | Adapter | Core / Transport | 检测到危险操作 |
| `ApprovalApproved` / `ApprovalRejected` | Transport | Core / Adapter / Audit | 用户决策回调 |
| `PTYStarted` / `PTYExited` | Runtime | Core / Logger | 进程生命周期 |
| `MemoryUpdated` | Memory | Logger / Storage | 长期记忆写入（摘要 / 事实 / 向量）完成 |
| `ErrorOccurred` | 任意 | Logger / Transport | 全局异常上报 |

> **零侵入扩展范例**：接入 RAG 时只需新增 `Memory` 模块订阅 `MessageGenerated`，Core 无感知。

### 3.4 CLI Adapter & Runtime（执行层）

> **本层的接缝设计（决策 D11）**：Core 只依赖语义化的 `CLIAdapter`，它说领域语义（一轮输入 / 流式输出 / 审批请求+决定 / 生命周期），**与「字节还是结构化」无关**。「字节 vs 结构化」的差异封死在 Adapter 内部。接缝**在 Adapter，不在 Runtime**——因为审批形态不对称（PTY 事后 scraping+写字节 vs SDK spawn 时传回调），字节级 `Runtime` 接口无法覆盖 SDK，硬套就是漏抽象。

```typescript
// Core / Transport 唯一依赖的抽象：厂商无关、传输无关。
interface CLIAdapter {
  readonly cliType: CliType;                // 'claude' | 'codex' | ...
  start(opts: SpawnOptions): Promise<void>;
  stop(): Promise<void>;
  interrupt(): void;                        // Ctrl+C / query.interrupt()
  sendUserInput(text: string): void;        // 一轮用户输入（非 PTY 泄漏）
  onOutput(cb: (d: { text: string; final: boolean }) => void): Unsubscribe;
  onApprovalRequest(cb: (req: ApprovalRequest) => void): Unsubscribe;
  resolveApproval(approvalId: string, decision: 'approve' | 'reject'): void;
  onExit(cb: (info: { code: number | null; reason: ExitReason }) => void): Unsubscribe;
  getState(): AdapterState;
}
```

Adapter 分**两个家族**，同实现 `CLIAdapter`、对 Core 完全同形：

- **SDK 家族（V1 首选，Claude 走这条）**：`ClaudeSdkAdapter` 内部持 `@anthropic-ai/claude-agent-sdk` 的 `query()` 句柄。输出来自结构化 `SDKMessage`；**审批来自 `canUseTool` 回调**——直接拿到工具名 + 完整参数，回 `allow`/`deny`。**无需 scraping、无 `Runtime`、无 `ApprovalDetector`**。那个"上下选、反色高亮"的 TUI 菜单只是渲染，程序接口里根本不存在。
- **PTY 家族（无 SDK 的 CLI 备用）**：`XxxPtyAdapter` 内部持 `PtyRuntime` + 一个 per-CLI `ApprovalDetector`。字节流剥 ANSI 得输出，正则 scraping 认出审批点，写 `y\r`/`n\r` 应答。scraping 随目标 TUI 版本漂移、脆，故仅在**没有 SDK** 时退而求其次。

- **PtyRuntime** 是 PTY 家族的底层字节容器（`node-pty`），**仅 PTY 家族使用**；SDK 家族的 Adapter 既不实现也不使用它。
- **厂商中立靠"每 CLI/SDK 一个 Adapter 实现 `CLIAdapter`"**，不靠"共享一个 SDK 基类"——不同厂商 SDK 的 API 表面不同，共性只在语义层。新增有 SDK 的 CLI = 新 Adapter，Core 零改动。

```mermaid
flowchart LR
    Core -->|abstract| Adapter[CLIAdapter 语义接缝]
    Adapter -.implements.-> SdkA[ClaudeSdkAdapter<br/>SDK 家族·首选]
    Adapter -.implements.-> PtyA[XxxPtyAdapter<br/>PTY 家族·备用]
    SdkA --> SDK[claude-agent-sdk<br/>query + canUseTool]
    PtyA --> Runtime[PtyRuntime]
    PtyA --> Detector[ApprovalDetector<br/>正则 scraping]
    Runtime --> pty[node-pty]
```

### 3.5 Message Aggregator（消息聚合器）

位于 **Adapter 输出** 与 **Transport 发送** 之间的缓冲过滤层，是流式体验与平台限流之间的缓冲带。
> 下图以 PTY 家族的高频字节为例；SDK 家族输出已是离散 `SDKMessage`，走同一管线但 debounce 压力小得多。

```mermaid
flowchart LR
    PTY[Adapter onOutput<br/>高频增量] --> BUF[Buffer 累积]
    BUF --> DEB{Debounce<br/>静默 N ms?}
    DEB -->|否/持续输出| THR[Throttle<br/>最小 Edit 间隔]
    DEB -->|是| FLUSH[Flush]
    THR --> FLUSH
    FLUSH --> MD[Markdown 合并<br/>+ 超长拆分]
    MD --> EV[发布 MessageGenerated]
```

- **Debounce**：输出静默一段时间后触发 flush，避免逐字符刷屏。
- **Throttle**：控制 `editMessage` 频率，规避 Telegram 的 Edit 限流（约 1 次/秒）。
- **拆分**：超过平台单条上限（TG 4096 字符）时自动分段。

### 3.6 Repository & Storage（持久层）

```typescript
interface ConversationRepository {
  create(c: NewConversation): Promise<Conversation>;
  updateStatus(id: string, status: SessionStatus): Promise<void>;
  findById(id: string): Promise<Conversation | null>;
}
// MessageRepository / AuditRepository / MemoryRepository 同构
```

- Repository 层封装全部 Drizzle 查询，Core 与业务模块**永不出现 SQL**。
- Storage 层负责连接、建表、迁移（Drizzle Kit）。V1 直接采用 **Postgres**；`pgvector` 扩展用于向量列（见 §7），关系数据与向量共库，无需独立向量服务。

### 3.7 Config Module（全局配置）

- **全项目唯一** 读取 `process.env` 的位置，其余模块通过依赖注入获取强类型配置对象。
- 使用 Zod 在启动时一次性校验，缺失/非法配置直接 fail-fast，杜绝运行期"配置未定义"。

```typescript
const ConfigSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  WHITELIST_USER_IDS: z.string().transform(s => s.split(',')),

  // 存储
  DATABASE_URL: z.string().url(),                    // postgres://user:pass@host:5432/hub

  // 记忆 / 嵌入
  EMBEDDING_API_BASE_URL: z.url().default('https://api.openai.com/v1'),
  EMBEDDING_API_KEY: z.string().min(1),
  EMBEDDING_MODEL: z.string().default('BAAI/bge-m3'),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(1024),
  MEMORY_RECALL_TOP_K: z.coerce.number().default(10), // 召回注入条数
  MEMORY_SUMMARY_API_BASE_URL: z.string().default(''),
  MEMORY_SUMMARY_API_KEY: z.string().default(''),
  MEMORY_SUMMARY_MODEL: z.string().default(''),
  MEMORY_REQUESTED_SUMMARY_MESSAGE_LIMIT: z.coerce.number().default(10),
  MEMORY_SUMMARY_MAX_CHARS: z.coerce.number().default(600),

  // 生命周期超时
  AGENT_IDLE_TIMEOUT_MS: z.coerce.number().default(300_000),    // 已启动 CLI/adapter 空闲回收（5min）
  SESSION_ARCHIVE_DAYS: z.coerce.number().default(7),           // 会话自动归档（天）
  RECENT_CONTEXT_LIMIT: z.coerce.number().default(10),           // adapter 刚启动时拼入的当前会话历史条数
  RECENT_CONTEXT_MESSAGE_MAX_CHARS: z.coerce.number().default(1200), // 单条历史消息尾部保留字符数
  DEBUG_AGENT_SDK_JSON: z.boolean().default(false),              // Agent SDK 原始 JSON
  DEBUG_MESSAGE_FLOW: z.boolean().default(false),                // 消息链路可观测日志
});
export type AppConfig = z.infer<typeof ConfigSchema>;
```

---

## 4. 端到端数据流

### 4.1 正常对话时序

```mermaid
sequenceDiagram
    participant U as 用户(TG)
    participant T as Transport
    participant B as EventBus
    participant C as Core
    participant M as Memory
    participant A as Adapter/Runtime
    participant G as Aggregator
    participant R as Repository

    U->>T: 发送消息
    T->>T: 白名单校验
    T->>B: emit MessageReceived
    B->>C: 路由到活跃 Session
    C->>M: 取全局事实 + 召回相关记忆 Top-K
    M-->>C: 拼接为上下文前缀
    C->>C: 状态 idle→Starting（如无 Runtime）
    C->>A: start() / sendUserInput(记忆+用户输入)
    C->>R: 保存 user message
    A-->>G: onOutput 流式增量（SDK：SDKMessage / PTY：字节 chunk）
    G->>B: emit MessageGenerated（聚合后）
    B->>T: editMessage 流式刷新
    B->>R: 保存 assistant message
    B->>M: 异步：抽取事实 / 生成摘要 / 调嵌入 API 写向量
    A->>B: PTYExited（空闲回收后，Session 转 idle）
```

> **两个记忆钩子**：① 入站侧「召回注入」——adapter start 前先全量注入实例级全局事实，再按 Top-K 追加检索召回；② 出站侧「异步写入」——`MessageGenerated` 后台触发嵌入与摘要，**不阻塞**对话主链路。详见 §7。

### 4.2 审批（Human-in-the-loop）时序

```mermaid
sequenceDiagram
    participant A as Adapter
    participant B as EventBus
    participant C as Core
    participant T as Transport
    participant U as 用户
    participant AU as Audit
    participant AR as AuditRepository

    A->>A: 审批点命中（SDK：canUseTool 回调 / PTY：ApprovalDetector scraping）
    A->>B: emit ApprovalRequested
    B->>C: conversation 持久状态保持 running
    B->>T: sendApproval（Markdown 卡片 + [Approve]/[Reject]）
    T->>U: 展示内联按钮
    U->>T: 点击 Approve
    T->>B: emit ApprovalApproved
    B->>AU: 订阅决策事件
    AU->>AR: 记录审批（时间/操作人/内容/决策）
    B->>A: resolveApproval(id, 'approve')
    Note over A: SDK 家族→resolve({behavior:'allow'})；PTY 家族→write("y\r")
    Note over T,U: 拒绝 → interrupt() + resolveApproval(id,'reject')（SDK: deny / PTY: "n\r" 或 Ctrl+C）
```

---

## 5. 会话生命周期与状态机

本系统有**两条独立的生命周期**，PRD 曾将二者混为一谈，此处明确拆分：

| 层 | 存活位置 | 单位 | 回收/结束条件 |
|---|---|---|---|
| **会话层 Conversation** | Postgres（长期） | 一次连续工作任务 / 一个项目上下文 | 显式 `/close` 或 `SESSION_ARCHIVE_DAYS` 天无活动 → 归档 |
| **CLI/adapter 运行时** | 内存（临时） | 一个 SDK query 或 node-pty 子进程 | `AGENT_IDLE_TIMEOUT_MS` 空闲 → 关闭已启动的 CLI/adapter，conversation 保持 `idle` |

> **核心区分**：`进程被回收` ≠ `会话被关闭`。进程回收后会话状态是 **`idle`**（可随时唤醒复用）；`/close`、`/new`、`/cwd <path>` 或长期无活动才进入 **`closed`（归档）**。

### 5.1 什么时候新建一个会话（会话边界策略）

采用 **cwd 复用 + 显式命令 + 自动归档** 的混合策略：

```mermaid
flowchart TD
    MSG[收到用户消息] --> CMD{系统命令?}
    CMD -->|/cwd path| CLOSESET[关闭当前会话<br/>更新目标 cwd<br/>不创建 conversation]
    CMD -->|/new| CLOSENEW[关闭当前/目标旧会话<br/>新建 idle conversation]
    CMD -->|否| FIND{最新同边界会话<br/>未 closing/closed?}
    FIND -->|是| REUSE[复用该会话]
    FIND -->|否| CREATE[新建 idle conversation]
    CLOSENEW --> RUN[等待首条普通消息懒启动]
    CREATE --> RUN
    REUSE --> RUN
```

- **默认复用**：普通消息优先复用该用户最新可复用会话（`idle/starting/running`）；若 Transport 重启丢失内存目标，用该会话的 `cli/cwd` 恢复目标并继续复用 `idle`。
- **`/new`**：强制开新会话；新建前兜底关闭该用户所有非 `closed` 历史会话，新会话初始 `idle`。
- **`/cwd`**：无参数显示当前目标 cwd；带路径时关闭当前会话、更新目标 cwd，不创建 conversation，下一条普通消息再新建。
- **`/close`**：显式结束，触发归档并生成 episodic 摘要（见 §7）。
- **自动归档**：超过 `SESSION_ARCHIVE_DAYS` 无活动的 `idle` 会话自动转 `closed` 并生成摘要。
- **cwd 归属**：`cwd` 仍记录会话工作目录；切换目录必须走 `/cwd` 关闭当前会话并更新目标，避免多个目录同时留下 `idle`。

### 5.2 会话状态机

```mermaid
stateDiagram-v2
    [*] --> Idle: SessionCreated
    Idle --> Starting: MessageReceived（无 Runtime）
    Starting --> Running: Adapter start 成功
    Running --> Idle: CLI/adapter 空闲超时（仅关闭已启动运行时，会话留存）
    Idle --> Closing: /close 或 归档超时
    Running --> Closing: /close
    Starting --> Closing: /close
    Closing --> Closed: 生成 episodic 摘要 + 落库
    Closed --> [*]
    note right of Idle
      进程已回收、会话仍在。
      下次同边界消息 → Starting 唤醒复用；
      不回放完整 messages，不 resume 旧 CLI 上下文。
    end note
```

审批不是持久化会话状态。`waitingApproval` 仅是 Adapter/Orchestrator 内存态：进程或 SDK query 结束后审批即失效，不能从 DB 恢复。

### 5.3 进程按需启停（资源回收）

```mermaid
flowchart TD
    M[收到消息] --> Q{Runtime 存在?}
    Q -->|否| S[启动 Runtime<br/>绑定 Adapter↔Session]
    Q -->|是| I[持续交互]
    S --> I
    I --> W{超出 AGENT_IDLE_TIMEOUT_MS?}
    W -->|否| I
    W -->|是| K[销毁 Runtime 进程<br/>释放内存]
    K --> P[会话转 idle<br/>元数据保留于 DB]
    P --> M
```

> **收益**：内存占用与活跃进程数解耦，会话数量与 DB 容量挂钩而非内存，VPS 上可承载远超同时在线数的历史会话。

---

## 6. 数据模型

对应 PRD §6，由 Drizzle 定义 Schema。

```mermaid
erDiagram
    conversations ||--o{ messages : has
    conversations ||--o{ audit_logs : has
    conversations ||--o{ memories : "conv-level"

    conversations {
        string id PK
        string platform
        string user_id
        string cli
        string cwd "项目目录，会话边界"
        string status "idle|starting|running|closing|closed"
        int created_at
        int updated_at
    }
    messages {
        string id PK
        string conversation_id FK
        string role
        text content
        int created_at
    }
    audit_logs {
        string id PK
        string conversation_id FK
        text command
        string action
        string operator
        int created_at
    }
    memories {
        string id PK
        string namespace "实例级记忆命名空间，默认 global"
        string conversation_id FK "可空：全局事实/偏好/环境无归属会话"
        string type "episodic|semantic|preference"
        text content
        vector embedding "pgvector，V1.5 启用"
        string source_message_id
        real importance "重要度，遗忘依据"
        int access_count "召回频次"
        int last_accessed_at "遗忘曲线依据"
        string tag
        int created_at
    }
```

> `memories.namespace = 'global'` 是当前个人 VPS / AI Hub 实例的默认共享记忆池。Transport 的 `user_id` 只用于鉴权、会话隔离与审批操作者，不用于记忆隔离。`memories.conversation_id` 可空：填值即 conversation-derived（本项目/任务情节），为空即实例级全局事实/偏好/环境。`embedding` 列在 V1 建表即预留（可 NULL），V1.5 启用 `pgvector` 索引后填充。

| 表 | 写入触发 | 说明 |
|---|---|---|
| `conversations` | `SessionCreated` / 状态变更 | 会话全局状态与生命周期；`cwd` 决定会话边界 |
| `messages` | `MessageReceived` / `MessageGenerated` | 完整对话记录，用于历史查看、审计与后续摘要；当前不做完整上下文回放 |
| `audit_logs` | `ApprovalApproved/Rejected` | **强制、永久**，敏感指令审批留痕 |
| `memories` | `MemoryUpdated`（订阅 `MessageGenerated` 异步生成） | 长期记忆：摘要 / 事实 / 偏好 + 向量，详见 §7 |

---

## 7. 长期记忆子系统

记忆是本系统区别于"无状态 CLI 代理"的核心能力。设计目标：**跨会话记住实例环境、全局事实与项目上下文，且零侵入对话主链路**。

### 7.1 实例级记忆模型

| 层 | 归属 | 内容 | `conversation_id` |
|---|---|---|---|
| **Global / instance-level** | `namespace='global'` | 环境事实、全局偏好、手工 `/remember` 事实 | NULL |
| **Conversation-derived** | `namespace='global'` + `conversation_id` | 某次会话产出的情节摘要、项目/任务局部事实 | 填值 |

V1 记忆注入 = 取 **实例级全局记忆** + **environment 环境记忆**，在 adapter start 时全量注入。`SessionClosed` 不自动生成确定性会话摘录，避免把杂乱或不准确的信息写入长期记忆；conversation-derived 记忆只来自用户主动说“记住/记录/remember this”后触发的 LLM 摘要。`MEMORY_RECALL_TOP_K` 只限制会话派生记忆的检索召回部分，不限制全局事实注入；`/remember` 写入的 global 记忆不走 embedding 重复召回。自然语言“记住/记录/remember this”请求会触发 `MemorySummaryRequested`，Memory 模块按 `MEMORY_REQUESTED_SUMMARY_MESSAGE_LIMIT` 读取当前 conversation 最近的 user/assistant 消息调用 LLM 摘要，输出语言跟随当前用户 `/lang`，长度上限由 `MEMORY_SUMMARY_MAX_CHARS` 控制，避免 Claude SDK raw JSON 或宿主 memory 文件进入长期记忆。

### 7.2 记忆分型

| type | 生成方式 | 用途 |
|---|---|---|
| `episodic`（情节） | 会话归档 / 滚动时 LLM 摘要 | 记住"上次做了什么" |
| `semantic`（事实） | `/remember`、环境 upsert 或后续抽取 | 记住"实例/项目的稳定属性" |
| `preference`（偏好） | `/remember` 或后续抽取 + 去重合并 | 记住"操作者希望怎样交互" |

### 7.3 写入侧：异步嵌入（订阅 `MessageGenerated`）

```mermaid
flowchart LR
    EV[MessageGenerated] --> MEM[Memory 模块]
    MEM --> EX[① Extract 抽事实/偏好]
    MEM --> SUM{② 会话满 N 条<br/>或归档?}
    SUM -->|是| S[LLM 生成 episodic 摘要]
    EX --> EMB[③ 调嵌入 API 生成向量]
    S --> EMB
    EMB --> W[④ 写 MemoryRepository<br/>emit MemoryUpdated]
```

- 全程**后台异步**，失败重试，**绝不阻塞** §4.1 的对话主链路。
- 嵌入统一走 OpenAI-compatible API（`EMBEDDING_API_BASE_URL` + `EMBEDDING_MODEL`），批量提交降低成本。

### 7.4 召回侧：向量检索注入（RAG）

```mermaid
flowchart LR
    IN[用户新消息] --> Q[嵌入为 query 向量]
    Q --> KNN[pgvector KNN<br/>namespace 过滤 + Top-K]
    KNN --> RANK[按 相似度 × importance 重排]
    RANK --> INJ[拼为上下文前缀<br/>注入 sendUserInput]
    INJ --> UPD[命中记忆 access_count++<br/>last_accessed_at 更新]
```

- `MEMORY_RECALL_TOP_K` 控制检索召回条数，避免上下文膨胀；实例级全局事实/环境/偏好全量注入，不参与 Top-K 截断。
- 命中即更新访问统计，作为**遗忘/衰减**依据（低 importance + 久未访问的记忆可定期清理或降权）。

### 7.5 分阶段落地（V1 → V1.5）

| 阶段 | 存储 | 检索能力 | 说明 |
|---|---|---|---|
| **V1** | Postgres（含预留 `embedding` 列，可 NULL） | 实例级全局记忆全量取回 + 环境记忆 upsert | 先跑通 `/remember`、环境事实与启动注入 |
| **V1.5** | 同库启用 `pgvector` + HNSW 索引 | 向量语义召回 Top-K | 填充 `embedding`，接入 §7.4 召回钩子 |

> **一次定库、分阶段加能力**：数据库第一版即 Postgres，避免 SQLite→PG 二次迁移；向量作为召回精度增强在 V1.5 平滑接入，Repository 接口不变，Core 零改动。

---

## 8. 安全架构

采用**纵深防御（Defense in Depth）**，三道防线逐层收敛风险。

```mermaid
flowchart TB
    R[外部请求] --> D1
    subgraph D1["① 边界防线 - Transport"]
        WL{白名单校验}
    end
    WL -->|非白名单| DROP[静默丢弃]
    WL -->|通过| D2
    subgraph D2["② 执行防线 - Approval"]
        AP{危险操作检测}
    end
    AP -->|需审批| HITL[Human-in-the-loop 卡片]
    AP -->|安全| RUN[直接执行]
    HITL --> D3
    subgraph D3["③ 审计防线 - Audit"]
        AL[永久审计日志]
    end
    RUN --> AL
```

1. **白名单前置**：硬编码 User ID 白名单，启动时加载；非白名单请求在 Transport 层直接丢弃，**永不进入 Core**。
2. **交互式审批**：危险操作触发 Adapter 内存态 `waitingApproval`，用户通过内联按钮决策 → Orchestrator 调 `adapter.resolveApproval(id, 'approve'|'reject')`；拒绝时先 `interrupt()` 停止当前轮。conversation 持久状态保持 `running`。
3. **永久审计**：每次审批的时间、操作人、内容、决策结果强制落 `audit_logs`，不可删除。

---

## 9. 目录结构与技术选型映射

### 9.1 目录 → 职责 → 选型

| 目录 | 架构角色 | V1 技术选型 |
|---|---|---|
| `core/` | 调度层 / 状态机 | 纯 TypeScript |
| `event/` | Event Bus | 类型安全 EventEmitter |
| `config/` | 配置中心 | Zod |
| `transport/` | 接入层 | Telegraf（TG）/ NapCat+Koishi（QQ） |
| `cli/` | Adapter（语义接缝） | 自研（base + `ClaudeSdkAdapter` 走 `@anthropic-ai/claude-agent-sdk`） |
| `runtime/` | PTY 家族字节容器（仅无 SDK 的 CLI 用） | node-pty |
| `approval/` | PTY 家族审批 scraping（SDK 家族无需） | 正则匹配 |
| `repository/` | 数据抽象 | Repository 接口 |
| `storage/` | 持久化实现 | **Postgres + Drizzle ORM**（V1.5 加 `pgvector`） |
| `memory/` | 长期记忆子系统 | 嵌入 API（默认 `BAAI/bge-m3`）+ pgvector |
| `logger/` | 全局日志 | Pino |
| `shared/` | 类型与工具 | 纯 TypeScript |

**运行环境**：Bun；**进程守护**：PM2 / systemd。

### 9.2 启动与装配（Composition Root）

依赖注入的组装点集中在入口，遵循"实现向抽象注册"：

```mermaid
flowchart TD
    ENTRY[main.ts / 装配根] --> CFG[加载并校验 Config]
    CFG --> BUS[创建 EventBus]
    BUS --> DB[初始化 Storage + Repositories]
    DB --> CORE[创建 Core Hub 注入 Bus/Repo]
    CORE --> REG[注册 Adapters: ClaudeSdkAdapter]
    REG --> TP[启动 Transports: TelegramTransport]
    TP --> READY[系统就绪]
```

> 装配根是**唯一**知晓所有具体实现的地方；一旦装配完成，运行期各模块只面向接口协作。

---

## 10. 关键横切关注点

| 关注点 | 架构处理 |
|---|---|
| **可观测性** | Logger 订阅全部事件，统一结构化日志（Pino）；`ErrorOccurred` 集中上报 |
| **背压 / 限流** | Aggregator 的 Throttle 保护 Transport；平台限流不反压到 PTY |
| **故障隔离** | 单个 Runtime/adapter 崩溃发退出事件或错误事件，conversation 回到 `idle` 或保留 `starting` 供排障，不影响其它会话 |
| **幂等与去重** | 审批回调按 `MessageRef` 去重，防止用户重复点击导致重复注入 |
| **优雅关闭** | 收到 SIGTERM → 停止 Transport 入站 → flush Aggregator → 销毁全部 Runtime → 关闭 DB |

---

## 11. 演进路线的架构支撑

当前解耦设计保证未来扩展**零侵入 Core**：

```mermaid
flowchart LR
    subgraph 新增CLI
        NC[实现 CLIAdapter] --> RC[装配根注册]
    end
    subgraph 新增客户端
        NT[实现 Transport] --> RT2[装配根注册]
    end
    subgraph 新增能力RAG
        NM[MemoryRepository<br/>订阅 MessageGenerated] --> NV[接入 Vector DB]
    end
    RC & RT2 & NM -.->|Core 无需改动| CORE[Core Hub]
```

| 演进项 | 落地方式 | 影响面 |
|---|---|---|
| 新增 Codex / Gemini CLI | 新增 `CodexAdapter` 并注册 | 仅 `cli/` |
| 新增 HTTP / MCP 客户端 | 新增 `HTTPTransport` 并注册 | 仅 `transport/` |
| V1.5 启用向量语义召回 | 同库开 `pgvector`，填充 `embedding` 列，接入召回钩子 | 仅 `memory/` + `storage/`，Repository 接口不变 |
| 记忆遗忘 / 压缩策略 | Memory 模块按 `importance × last_accessed` 定期清理 | 仅 `memory/`，对话主流程零改动 |

---

## 附录：架构决策记录（ADR 摘要）

| # | 决策 | 理由 | 权衡 |
|---|---|---|---|
| 1 | Event Bus 作为唯一通信枢纽 | 彻底解耦，支持零侵入扩展 | 调试链路需靠日志串联事件 |
| 2 | 会话层与进程层双层解耦 | 进程回收省内存，会话长存可唤醒 | 需明确区分 `idle`(回收) 与 `closed`(归档) |
| 3 | Config 独占 `process.env` | 强类型校验、fail-fast、可测试 | 需依赖注入贯穿全局 |
| 4 | Aggregator 独立成层 | 隔离平台限流与流式渲染 | 增加一次输出延迟（Debounce 窗口） |
| 5 | V1 直接选 Postgres + Drizzle | 一次定库避免二次迁移；`pgvector` 可同库存向量 | VPS 多一个 DB 服务进程（docker 一把梭，可接受） |
| 6 | 记忆归属实例级 namespace，不按 Transport user_id 隔离 | 个人 VPS 的 Telegram/QQ/WebSocket 操作者本质共享同一套环境事实与全局记忆；`user_id` 只服务会话隔离/鉴权/审批操作者 | 需用 `namespace` 支撑未来多人格/工作区；全局事实由 `conversation_id` 是否为空区分 |
| 7 | 嵌入走 API 而非本地模型 | VPS 不跑模型，省内存运维 | 有网络延迟与调用成本 → 强制异步批量，V1 可先不用 |
| 8 | 向量召回分阶段（V1.5 上 pgvector） | V1 先跑通命令式记忆与环境注入，不被召回调优拖慢 | V1 无语义模糊召回 |
| 9 | 会话边界 = cwd 目标 + `/new` + `/cwd` + 归档 | 贴合 CLI 控制语义，会话按项目目录隔离；记忆在 namespace 内共享并通过 `conversation_id` 标注来源 | `conversations` 需加 `cwd` 字段；用户目标 cwd 当前为运行期状态，后续偏好模块持久化 |
| 10 | **执行层接缝在语义化 `CLIAdapter`，非 `Runtime`；Claude 走 Agent SDK，PTY 家族仅作无 SDK 备用**（详见 D11） | 审批/输出结构化（`canUseTool`+`SDKMessage`）根治"解析 TUI 菜单"的脆性；接缝在 Adapter 才能同时容纳字节与结构化两形态；厂商中立靠"每 CLI 一个 Adapter"而非共享 SDK 基类 | SDK 依赖 +5.5MB（含原生二进制，依赖树干净、peerDeps zod^4 与本项目一致）；`Runtime`/`ApprovalDetector` 降级为 PTY 家族专属 |
