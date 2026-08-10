# 03 - 接口契约（Interface Contracts）

> 本文件是所有模块间**契约的唯一真相源**。实现任何 Transport / Adapter / Repository 前，严格按此签名，不擅自改动。
> 与 [02-架构](./02-Architecture.md) 对应；数据表见 [04-数据模型](./04-Data-Model.md)。
>
> 约定：所有接口最终落在 `src/shared/types/`（纯类型，叶子模块），实现分散在各业务目录。

---

## 0. 基础类型（`shared/types/common.ts`）

```typescript
export type Platform = 'telegram' | 'qq' | 'web';
export type CliType = 'claude' | 'opencode' | 'codex' | 'gemini';

// 持久化会话状态（落库 conversations.status，对应 02-架构 §5.2 状态机；决策 D28）
// ⚠️ 仅这 5 态入库。审批（waitingApproval）是**运行期** AdapterState，永不落库，见 §3.1。
export type SessionStatus =
  | 'idle'            // 无活跃进程，可唤醒
  | 'starting'        // 正在拉起 Runtime
  | 'running'         // 交互中
  | 'closing'         // 归档中
  | 'closed';         // 已归档

export type Role = 'user' | 'assistant' | 'system';
export type MemoryType = 'episodic' | 'semantic' | 'preference';
export type ApprovalAction = 'approve' | 'reject';

// 分支品牌类型，防止 ID 串用
export type ConversationId = string & { readonly __brand: 'ConversationId' };
export type MessageId = string & { readonly __brand: 'MessageId' };

export type Unsubscribe = () => void;

// Transport 侧消息句柄：抽象各平台 message_id 差异，供 editMessage 定位
export interface MessageRef {
  platform: Platform;
  chatId: string;
  nativeId: string; // TG message_id / QQ 序号 ...
}
```

---

## 1. Event Bus（`event/`）

事件总线是**模块间唯一通信枢纽**。类型安全，payload 由 `EventMap` 钉死。

```typescript
export interface EventBus {
  emit<E extends keyof EventMap>(type: E, payload: EventMap[E]): void;
  on<E extends keyof EventMap>(type: E, handler: (p: EventMap[E]) => void): Unsubscribe;
  once<E extends keyof EventMap>(type: E, handler: (p: EventMap[E]) => void): Unsubscribe;
}
```

### 1.1 EventMap —— 每个事件的精确 payload

```typescript
export interface EventMap {
  // —— 会话生命周期 ——
  SessionCreated:   { conversationId: ConversationId; platform: Platform; userId: string; cli: CliType; cwd: string };
  SessionMapped:    { conversationId: ConversationId; platform: Platform; userId: string };
  SessionClosed:    { conversationId: ConversationId; reason: 'user' | 'archiveTimeout' };
  ConversationCleared: { conversationId: ConversationId }; // 兼容路径：请求文件生命周期模块清理文件
  ConversationContextReset: { conversationId: ConversationId }; // 持久内容清除后停止当前 adapter

  // —— 消息 ——
  MessageReceived:  { userId: string; platform: Platform; cli: CliType; cwd: string; text: string; promptText?: string; ref: MessageRef; attachments?: InboundAttachment[] };
  // text 始终是用户可见原文并用于落库；图片 OCR/文件上下文只进入 promptText。
  MessageGenerated: { conversationId: ConversationId; content: string; final: boolean; attachments?: StoredMessageAttachment[] }; // final=false 为流式增量
  MessagePersisted: { conversationId: ConversationId; ref: MessageRef; message: { id: string; role: 'user'; content: string; attachments: StoredMessageAttachment[]; createdAt: number } };
  CommandReply:     { ref: MessageRef; content: string; copyActions?: CopyAction[]; attachments?: StoredMessageAttachment[] };
  UserLanguageChanged: { userId: string; platform: Platform; language: 'zh' | 'en' };
  UserTargetChanged: { userId: string; platform: Platform; cli?: CliType; cwd?: string }; // /switch 更新当前选中 CLI/cwd
  UserPreferencesReset: { userId: string; platform: Platform }; // /reset 后停止该用户 adapter

  // —— 审批（Human-in-the-loop）——
  ApprovalRequested: { conversationId: ConversationId; approvalId: string; command: string; detail: string; createdAt: number; autoApproveAt?: number; autoApproveSeconds?: number };
  ApprovalApproved:  { conversationId: ConversationId; approvalId: string; operator: string; automatic?: boolean };
  ApprovalRejected:  { conversationId: ConversationId; approvalId: string; operator: string };

  // —— 进程 ——
  PTYStarted: { conversationId: ConversationId; pid: number };
  PTYExited:  { conversationId: ConversationId; code: number | null; reason: 'idleTimeout' | 'crash' | 'stop' };

  // —— 记忆 ——
  MemoryUpdated: {
    namespace: string;              // 默认 'global'：当前实例级共享记忆池
    memoryType: MemoryType;
    memoryId: string;
    operatorUserId?: string;        // 命令操作者，仅用于日志/审计，不作为记忆隔离键
  };
  MemorySummaryRequested: {
    conversationId: ConversationId;
    userId: string;
    language: 'zh' | 'en';          // 跟随当前用户 /lang，用于摘要输出语言
    reason: 'userRememberRequest';
    text: string;
  };

  // —— 错误 ——
  ErrorOccurred: { scope: string; message: string; cause?: unknown; conversationId?: ConversationId };
}
```

> 新增事件 = 在此扩展 `EventMap` 一处，其余全类型推导。发布者/订阅者对照见 [02-架构 §3.3](./02-Architecture.md)。

---

## 2. Transport（`transport/`）

屏蔽客户端协议差异，向 Core 提供统一收发能力。

```typescript
export interface Transport {
  readonly platform: Platform;

  start(): Promise<void>;
  stop(): Promise<void>;

  sendMessage(chatId: string, content: string): Promise<MessageRef>;
  sendConversationMessage(conversationId: ConversationId, content: string): Promise<MessageRef | null>;
  editMessage(ref: MessageRef, content: string): Promise<void>;
  deleteMessage(ref: MessageRef): Promise<void>;
  sendApproval(chatId: string, card: ApprovalCard): Promise<MessageRef>;
}

export interface ApprovalCard {
  approvalId: string;
  title: string;       // Markdown
  command: string;     // 待审批命令
  detail: string;      // 上下文说明
  // 内联按钮固定为 [Approve] / [Reject]
}
```

**实现约束**：
- 入站：收到消息 → **白名单校验** → 非白名单**静默丢弃**（不进 Core）→ 白名单则 `bus.emit('MessageReceived', ...)`。
- 出站：订阅 `MessageGenerated`（流式 `editMessage`）与 `ApprovalRequested`（`sendApproval`）。
- 审批按钮点击 → `bus.emit('ApprovalApproved'|'ApprovalRejected', ...)`。

---

## 3. CLI Adapter & Runtime（`cli/` + `runtime/` + `approval/`）

> **接缝在语义化的 `CLIAdapter`，不在 `Runtime`（决策 D11）。** Core / Transport 只依赖 `CLIAdapter`，它说的是**领域语义**（一轮输入 / 流式输出 / 审批请求+决定 / 生命周期），与「字节还是结构化」无关。字节 vs 结构化的差异**封死在 Adapter 内部**。
>
> Adapter 分**两个家族**，同实现 `CLIAdapter`、对 Core 完全同形：
> - **SDK 家族（Claude/opencode 等提供 SDK 的 CLI，首选）**：`ClaudeSdkAdapter` 内部持 `@anthropic-ai/claude-agent-sdk` 的 `query()` 句柄；`OpenCodeSdkAdapter` 通过由 Composition Root 管理的共享、引用计数 `opencode serve` 获取 client，但每个 adapter 创建独立 session、仅消费本 session 的 SSE 事件。输出来自结构化消息/事件，审批来自 SDK 回调或 permission 事件，无需 scraping、无 `Runtime`、无 `ApprovalDetector`。OpenCode text/tool part 只有在其 `messageID` 已由 `message.updated.info.role` 确认为 assistant 时才可转成 `OutputDelta`；user/noReply context part 必须丢弃。
> - **PTY 家族（无 SDK 的 CLI 备用）**：`XxxPtyAdapter` 内部持 `PtyRuntime`（§3.2）+ 一个 per-CLI `ApprovalDetector`（§3.3）。字节流剥 ANSI 得输出，正则 scraping 认出审批点。**这些脏活被关在 Adapter 内部，不外泄。**

### 3.1 CLIAdapter（`cli/base.ts`）—— Core / Transport 唯一依赖的语义抽象

```typescript
export interface CLIAdapter {
  readonly cliType: CliType;

  start(opts: SpawnOptions): Promise<void>;
  stop(): Promise<void>;
  interrupt(): void;                                  // Ctrl+C / query.interrupt()

  sendUserInput(text: string): void;                  // 一轮用户输入（字符串在两家族天然成立，非 PTY 泄漏）

  onOutput(handler: (delta: OutputDelta) => void): Unsubscribe;         // 用户可见输出（语义，非裸字节；Claude SDK 家族只发 result.result）
  onApprovalRequest(handler: (req: ApprovalRequest) => void): Unsubscribe;
  resolveApproval(approvalId: string, decision: ApprovalAction): void;  // 'approve' | 'reject'
  onExit(handler: (info: ExitInfo) => void): Unsubscribe;
  listModels(): Promise<CliModel[]>;
  setModel(modelId: string): Promise<string>;

  getState(): AdapterState;
}

export interface OutputDelta {
  /** 输出类型：text=用户可见文本；其它类型保留给 PTY/未来 adapter 内部转换 */
  kind: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text: string;               // kind=text/tool_result/thinking 时填充；tool_use 时为空
  final: boolean;              // false=增量，true=本轮结束
  toolName?: string;           // kind=tool_use 时填充（如 "Bash" "Write"）
  toolInput?: Record<string, unknown>;  // kind=tool_use 时填充
}

export interface ApprovalRequest {
  approvalId: string;
  command: string;   // SDK：工具名（如 "Bash"）；PTY：scraping 提取的命令
  detail: string;    // SDK：JSON.stringify(input)；PTY：上下文
}

export interface ExitInfo {
  code: number | null;
  reason: 'idleTimeout' | 'crash' | 'stop';
}

export interface SpawnOptions {
  conversationId: ConversationId;
  cwd: string;
  cols?: number;     // 仅 PTY 家族使用；SDK 家族忽略
  rows?: number;     // 仅 PTY 家族使用；SDK 家族忽略
  env?: Record<string, string>;
  systemLanguageHint?: string;
  modelId?: string;
}

export type AdapterState = 'stopped' | 'starting' | 'ready' | 'busy' | 'waitingApproval';
```

> **事件映射**：Adapter 的 `onApprovalRequest` → Orchestrator 补齐 `conversationId` 与稳定的 `createdAt` 后发 `ApprovalRequested`；Transport 的 [Approve]/[Reject] → `ApprovalApproved|ApprovalRejected` → Orchestrator 调 `adapter.resolveApproval(id, 'approve'|'reject')`。SDK 家族据此 `resolve({ behavior: 'allow'|'deny' })`；PTY 家族据此 `runtime.write("y\r"|"n\r")`。ApprovalAudit 旁路订阅同一事件流，持久化失败不阻塞 Adapter 决议。

> **共享只读查询策略**：所有 CLI Adapter 必须复用 `cli/utils.isReadOnlyShellCommand`。策略使用 `unbash` AST 和 `read-only | mutating | unknown` 三态模型；管道、`&&`、`||`、`;` 仅在所有叶子命令都确定只读时免审批，`cd <path>` 仅改变临时 shell 工作目录，属于只读链路的一部分；`2>&1` 以及仅把 stderr 丢到 `/dev/null` 的 `2>/dev/null` 不视为写文件，具名文件输出仍视为写入。`docker exec`、`bash/sh -c`、PowerShell/cmd 包装命令递归分析内部命令；`docker inspect` 与 `docker volume ls/inspect` 可带经验证的只读命令替换参数，`find` 仅在没有 `-delete`、`-exec`、`-fprint` 等副作用 action 时放行。`git pull` 会更新 Git 元数据且可能改写工作区，始终要求审批。解析失败、动态命令名和未知程序一律审批。Claude 在 `canUseTool(Bash)` 放行，OpenCode 在 `permission=bash` 时直接 reply `once`。

### 3.2 PtyRuntime（`runtime/`）—— **PTY 家族内部容器**，非跨形态抽象

```typescript
// PTY 家族（无 SDK 的 CLI）的底层字节容器。
// ⚠️ SDK 家族的 Adapter 既不实现也不使用它——它直接持 query() 句柄。
export interface PtyRuntime {
  spawn(opts: SpawnOptions): Promise<void>;
  write(data: string): void;                 // 注入字节，含 "y\r" / "n\r"
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (chunk: string) => void): Unsubscribe;   // 裸字节流（含 ANSI）
  onExit(handler: (code: number | null) => void): Unsubscribe;
}
// 当前无实现；接入首个无 SDK CLI 时再增加 NodePtyRuntime 与 node-pty 依赖。
// 注：这里刻意 **不** 定义「统一 SdkRuntime 让各家 SDK 继承」——审批形态不对称
// （PTY 事后 scraping+写字节 vs SDK spawn 时传回调），字节接口无法覆盖 SDK。
// 跨形态的共性只在 §3.1 语义层，见 D11。
```

### 3.3 ApprovalDetector（`approval/`）—— **仅 PTY 家族专属**

```typescript
// 仅 PTY 家族使用：从裸字节流中 scraping 出审批点。
// SDK 家族不需要 detector —— 审批经 canUseTool 结构化直达。
export interface ApprovalDetector {
  // 从 PTY 输出流中检测审批点；命中返回结构化信号，否则 null
  detect(chunk: string, buffer: string): ApprovalSignal | null;
}

export interface ApprovalSignal {
  command: string;   // 提取到的待审批命令
  detail: string;    // 上下文
}
// 例：某无 SDK 的 CLI 的 ApprovalDetector 用正则匹配 [Y/n]。
// PtyAdapter 命中后 → onApprovalRequest → bus.emit('ApprovalRequested', ...)
// ⚠️ scraping 随目标 CLI 的 TUI 版本漂移，脆——故仅在无 SDK 时退而求其次。
```

---

## 4. Message Aggregator（`core/aggregator.ts` 或独立）

PTY 家族的高频字节输出 → 缓冲/去抖/限流 → 发 `MessageGenerated`。
> SDK 家族输出本就是**离散的 `SDKMessage`**（非字节洪流），聚合大幅简化——仍走同一 `push/flush` 接口，但 debounce 压力小得多。

```typescript
export interface MessageAggregator {
  // 喂入原始 chunk（来自 adapter.onData）
  push(conversationId: ConversationId, chunk: string): void;
  // 强制冲刷（会话结束/审批前）
  flush(conversationId: ConversationId): void;
  // 优雅关闭前冲刷所有会话草稿
  flushAll(): void;
  // /clear、/reset 时丢弃指定会话未定稿输出，防止旧回复延迟发送
  discard(conversationId: ConversationId): void;
  // 清理定时器和内存状态；调用前应先 flushAll()
  destroy(): void;
}

export interface AggregatorConfig {
  debounceMs: number;     // 静默多久触发 flush（如 400）
  minEditIntervalMs: number; // 最小 edit 间隔，规避平台限流（如 1000）
  maxChunkChars: number;  // 单条上限，超出拆分（TG 4096）
}
```

---

## 5. Repository（`repository/`）—— 唯一 SQL 出口

Core 与业务模块只依赖这些接口，不碰 Drizzle。表结构见 [04-数据模型](./04-Data-Model.md)。

```typescript
export interface ConversationRepository {
  create(c: NewConversation): Promise<Conversation>;
  // scope=(platform,userId,cli) 内最新可复用会话，不返回 closing/closed。
  findLatestOpen(platform: Platform, userId: string, cli: CliType): Promise<Conversation | null>;
  findById(id: ConversationId): Promise<Conversation | null>;
  listRecentByUser(platform: Platform, userId: string, limit: number): Promise<Conversation[]>;
  updateStatus(id: ConversationId, status: SessionStatus): Promise<void>;
  // 进程重启对账：starting/running 复位 idle，closing 收尾 closed。
  reconcileRuntimeStatuses(now: number): Promise<void>;
  listStaleIdle(beforeTs: number): Promise<Conversation[]>; // 归档扫描
}

export interface MessageRepository {
  append(m: NewMessage): Promise<Message>;
  // limit 存在时返回 before 游标之前最新 N 条，结果仍按时间正序。
  listByConversation(id: ConversationId, limit?: number, before?: { createdAt: number; id: string }): Promise<Message[]>;
}

export interface AuditRepository {
  createPending(audit: NewAuditLog, timelineMessage?: NewMessage): Promise<void>;
  resolve(input: {
    conversationId: ConversationId;
    approvalId: string;
    status: 'approved' | 'rejected';
    operator: string;
    automatic: boolean;
  }): Promise<AuditLog | null>;
  findByIds(ids: readonly string[]): Promise<AuditLog[]>;
  listByConversation(id: ConversationId): Promise<AuditLog[]>;
}

// 审计范围：ApprovalRequested 创建 pending 生命周期记录，手动/自动决议更新同一行；
// 自动操作人格式为 auto:<userId>。Web 会话在同一事务中额外创建 contextEligible=false
// 的 messageType=approval 引用消息；Telegram/QQ 不创建 Hub 时间线引用。
// /audit [conversationId] 直接格式化结构化 request/status/automatic/operator。

export interface MemoryRepository {
  insert(m: NewMemory): Promise<Memory>;
  // M8：环境快照等稳定 tag 记忆幂等写入；同 namespace+tag 存在则更新 content/type/importance。
  upsertByTag(namespace: string, tag: string, m: Omit<NewMemory, 'id' | 'namespace' | 'tag' | 'createdAt'>): Promise<Memory>;
  // 返回 namespace 全部记忆；调用方全量注入 semantic/preference，仅向量召回 episodic。
  listGlobal(namespace: string): Promise<Memory[]>;
  findById(id: string): Promise<Memory | null>;
  // V1：关系 + FTS 检索；用于后续跨会话召回补充，受 topK 限制。
  searchByKeyword(namespace: string, query: string, topK: number): Promise<Memory[]>;
  // V1.5：向量检索（embedding 非空时启用）
  searchByVector(namespace: string, embedding: number[], topK: number): Promise<Memory[]>;
  setEmbedding(id: string, embedding: number[]): Promise<void>;
  touch(id: string): Promise<void>; // access_count++ / last_accessed_at
  delete(id: string): Promise<void>;
}

export interface UserPreferenceRepository {
  getOrCreate(input: { platform: Platform; userId: string; language: UserLanguage; defaultCli: CliType }): Promise<UserPreference>;
  setLanguage(platform: Platform, userId: string, language: UserLanguage): Promise<void>;
  setDefaultCli(platform: Platform, userId: string, cli: CliType): Promise<void>;
  setAutoApprove(platform: Platform, userId: string, enabled: boolean, seconds: number): Promise<void>;
  findCliPreference(platform: Platform, userId: string, cli: CliType): Promise<UserCliPreference | null>;
  upsertCwd(platform: Platform, userId: string, cli: CliType, cwd: string): Promise<void>;
  setModel(platform: Platform, userId: string, cli: CliType, modelId: string): Promise<void>;
  reset(platform: Platform, userId: string, defaults: ReadonlyArray<{ cli: CliType; cwd: string }>): Promise<void>;
}

export interface ConversationFileRepository {
  createNext(input: NewConversationFile): Promise<ConversationFile>;
  findBySequence(conversationId: ConversationId, sequence: number): Promise<ConversationFile | null>;
  findById(conversationId: ConversationId, id: string): Promise<ConversationFile | null>;
  listByConversation(conversationId: ConversationId, limit: number, keyword?: string): Promise<ConversationFile[]>;
  deleteByConversation(conversationId: ConversationId): Promise<ConversationFile[]>;
}
```

`conversation_files.file_id` 是唯一且可空的平台稳定标识：Telegram 写入 Bot API 的
`file_unique_id`；QQ 当前没有等价稳定标识，因此写入 `NULL`。平台下载 URL 只在入站下载期间使用，
不写入数据库；Telegram 用于本次下载的短期 `file_id` 同样不持久化。

`UserPreferenceRepository` 是用户级持久化目标的唯一 SQL 出口：按 `(platform,userId)` 保存 `/lang`、默认 CLI 与自动审批开关，并按 `(platform,userId,cli)` 保存 cwd、model ID 与 model name；不使用无类型的通用 KV 表。`/reset` 通过 upsert/update 恢复默认值而非删除记录，并同步更新该用户所有未关闭 conversation 的 cwd。

> `New*` 为插入用类型（无 id/时间戳），`Conversation`/`Message`/... 为读取用完整类型，均由 Drizzle `$inferInsert` / `$inferSelect` 推导，见 04。

---

## 6. Config（`config/`）—— `settings.json` 唯一业务配置源

`SettingsJsonSchema` 使用 Zod 校验 `settings.json` 的 14 个嵌套分类，`loadConfig()` 在启动时 fail-fast，再展平为现有消费者使用的 `AppConfig`。

```typescript
export type SettingsJson = z.infer<typeof SettingsJsonSchema>;

export function loadConfig(
  source?: Partial<SettingsJson>,
  opts?: { settingsPath?: string },
): AppConfig;
```

- 默认读取项目根目录 `settings.json`；该文件 gitignore，模板为 `settings.json.example`。
- `bun run setting:migrate` 只对齐 JSON key 结构，不读取 `.env`。
- `session.claudeExecutablePath` 为空时从 `PATH` 解析系统 `claude`，非空时使用配置的绝对路径；启动找不到系统 CLI 时 fail-fast。
- 数据库的 host/port/db/username/password 被组装为兼容字段 `AppConfig.DATABASE_URL`；`db:migrate` 与主进程使用同一配置。
- 代理配置会写回 `process.env.HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`，仅用于 Bun fetch 和 SDK 子进程继承；`process.env` 不是业务配置输入源。
- `/update confirm` 依次执行 git pull、frozen bun install、format check、typecheck、lint、`webui:build:staged`、`setting:migrate`、`db:migrate` 和 `webui:promote`；任一步失败都不安排重启。新 WebUI 先构建到 `.data/update/webui-next`，全部关键步骤成功后才以目录 rename 替换 `public/webui`，提升失败时会恢复旧目录。WebUI 只在部署更新阶段构建，应用启动与 PM2 重启不得触发构建。Claude SDK 平台包已在依赖解析阶段由本地 stub override，不需要安装后裁剪。

---

## 7. Web Server HTTP API（`server/`）

HTTP 服务默认监听 `127.0.0.1:8787`，`http.host` 也支持配置为 `0.0.0.0` 对外监听。`server/` 负责静态 WebUI、SPA fallback、认证会话和兼容出站 API；它不直接依赖 Core、具体 Transport 或 Drizzle，所需能力一律由 `main.ts` 注入。

对外监听必须配置 `http.authToken`，并置于 HTTPS 反向代理、防火墙限制之后。HTTPS 部署时将 `http.secureCookie` 设为 `true`，使 Web 会话 Cookie 带 `Secure` 属性。未配置 `http.authToken` 时，Web 登录接口返回 `503`，所有受保护的 `/api/*` 和 `/ws` 请求返回 `401`；空 Token 不再表示关闭鉴权。

### `GET /health/live`、`GET /health/ready` 与 `GET /health`

三个探针均公开且不依赖 Token。`/health/live` 只证明 HTTP 进程仍能响应，固定返回 `200 { "status": "ok" }`。`/health/ready` 检查数据库、媒体目录和 CLI，返回 `status`、`uptimeMs` 与逐项 `checks`；总体为 `down` 时返回 503，`ok` 或非关键项导致的 `degraded` 返回 200。`/health` 是 readiness 的兼容别名。

### `POST /api/auth/session`

请求携带 `Authorization: Bearer <http.authToken>`，成功后创建由当前管理 Token 进行 HMAC 签名的 8 小时会话，并返回 `HttpOnly; SameSite=Strict; Path=/` Cookie。Cookie 只包含版本、到期时间与签名，不包含管理 Token；服务重启后仍可验证，修改 `http.authToken` 会立即使旧 Cookie 失效。Token 不会写入 Cookie、响应体、浏览器持久化存储或日志。

`GET /api/auth/session` 用 Bearer 或会话 Cookie 查询登录状态，并把有效期续至当前时间后的 8 小时；`DELETE /api/auth/session` 清除浏览器 Cookie。除健康检查外，配置了 Token 的 `/api/*` 接口均接受 Bearer 或该会话 Cookie。

### `GET /ws`

浏览器在已登录 Cookie 下升级 WebSocket。升级请求必须带 `Origin`，其 host 必须匹配请求 URL、`Host` 或反向代理传入的 `X-Forwarded-Host`，否则返回 403。单进程最多保留 5 个浏览器连接；第 6 个以 1013 关闭。Bun 层限制单帧 128 KiB、发送背压 256 KiB，并在超限时关闭连接；协议层进一步限制消息正文 64 KiB、单条消息最多 10 个上传 ID，标识符最长 128 字符。

JSON 信封为 `{ "v": 1, "type": "..." }`：上行 `message`（`text`、`clientMessageId`、可选 `uploadIds`）与 `approve`/`reject`（`conversationId`、`approvalId`）；下行 `connected`、`user_message`、`output`、`approval`、`approval_resolved`、`error`。`approval_resolved` 携带 `status=approved|rejected`、`operator`、`automatic`，自动或手动决议都会发送；同进程内重复操作不会再次发 EventBus 决议，而是重发既有终态并标记 `alreadyHandled=true`。`user_message` 将服务端规范化消息 ID 和持久化附件回执给浏览器，用于替换乐观消息；`output` 同时承载会话流式输出、持久化预览附件、服务重启通知和 `/help` 等命令回复。审批决定只接受当前 Web 连接已观察到的 Web 会话 ID，禁止借 WebSocket 操作 Telegram/QQ 或未知会话。浏览器断线后先检查认证状态：服务暂时不可达时使用指数退避重连，明确返回 `401` 时停止重连并回到登录页。重启完成通知在 Web 客户端重新连入前保持待发送状态，实际发送成功后才清除持久化通知标记。

### `GET` / `PUT /api/settings` 与 `/api/restart`

二者均要求已认证会话。`GET /api/settings` 仅返回脱敏配置；`PUT /api/settings` 校验后原子写入，敏感字段可保留 `{ "configured": true }`，保存成功返回 `restartRequired`。`GET /api/restart` 返回受控重启预览，`POST /api/restart` 执行既有受控重启能力。

### `GET /api/web/status`

要求已认证会话。仅返回 WebSocket 平台当前管理员会话的 `conversationId`、CLI、CWD、会话状态、模型和自动审批设置；绝不混入 Telegram 或 QQ 会话。

### `GET /api/web/history`

要求已认证会话。查询参数 `limit` 默认 10、范围 1–50，`before` 使用上一页返回的 opaque cursor。分页始终只查询 `messages`，返回 `type=chat|approval` 判别联合与 `nextCursor`；chat 项包含 user/assistant 正文和附件，approval 项通过 `auditLogId` 单次批量补齐结构化审计详情，缺失引用降级为 `approval:null` 而不使整页失败。单页内部按消息时间正序，审批引用本身占一个分页项目。WebUI 先建立 WebSocket 并缓冲实时事件，首屏历史完成后按消息 ID、clientMessageId 和 approvalId 去重回放；滚动到顶部时按游标加载更早项目并保持阅读位置。没有当前会话时返回 `{ messages: [], nextCursor: null }`。

### `GET /api/web/files/:id`

要求已认证会话。仅当文件属于当前 Web 会话且受控文件仍存在时返回内容，默认使用 `inline`；不能借此读取其他平台、其他会话或任意本地路径。图片附件在气泡内直接显示，点击或触摸即可放大；其他附件按类型显示卡片，点击或触摸即可下载。

### `POST /api/web/uploads`

要求已认证会话。请求体为单文件 multipart；Bun 的请求体硬上限为 `media.maxFileBytes + 1 MiB`，声明超限的 `Content-Length` 会提前返回 413。上传先进入隔离的 `.staging` 目录并返回一次性 ID：每个进程最多暂存 20 个文件、总大小最多为单文件上限的 3 倍、15 分钟未消费即删除；服务启动会清理上次异常退出遗留的暂存文件。WebSocket 消息消费整批 ID 时先完整校验，失败会回滚已移动文件，避免半成功消息。

### `POST /api/platform-msg`

按平台原生 Chat ID 发送。`chatId` 必须存在于 `transport.whitelistUserIds`，且 `platform` 对应的 Transport 必须已装配。

```json
{
  "platform": "telegram",
  "chatId": "7031086257",
  "content": "要发送的内容"
}
```

### `POST /api/session-msg`

按项目内部 `conversationId` 发送。会话必须存在、未关闭，并且当前进程仍保留该会话到平台 Chat ID 的映射。

```json
{
  "conversationId": "conversation-id",
  "content": "要发送的内容"
}
```

二者是不同的寻址方式：`chatId` 是 Telegram/QQ 的平台标识，`conversationId` 是 Hub 内部会话标识；两个接口不混用字段。两者始终要求有效的 Bearer Token 或已登录的 Web 会话 Cookie；`http.authToken` 为空时直接返回 401。

两个接口的 `content` 都支持多行文本。调用方应优先使用标准 JSON 转义（如 `\n`、`\t`）；为兼容部分 Webhook/自动化工具，服务端也接受 JSON 字符串值中直接出现的未转义换行、Tab 等控制字符，并按原内容转发。该兼容仅修复字符串内部的控制字符，缺少逗号、尾随逗号、引号不闭合等结构错误仍返回 HTTP 400。

---

## 8. Composition Root（`main.ts`）装配顺序

```typescript
const config = loadConfig();
const logger = createLogger(config);
const bus = createEventBus();

const db = createDb(config.DATABASE_URL);        // storage/
const repos = createRepositories(db);            // repository/

const core = createCoreHub({ bus, repos, config });   // 注入抽象
core.registerAdapter(new ClaudeSdkAdapter({ bus, config })); // SDK 家族，内部持 query()，无需 runtime
core.registerAdapter(new OpenCodeSdkAdapter({ bus, config, serverPool })); // SDK 家族，共享 serve、独立 session，审批经 permission 事件
createMemoryModule({ bus, repos, config });      // 订阅事件，无需 Core 感知

const transports = [
  config.TELEGRAM_BOT_TOKEN && new TelegramTransport({ bus, config }),
  config.QQBOT_APP_ID && new QQTransport({ bus, config }),
].filter(Boolean);
await Promise.all(transports.map(transport => transport.start()));
```

> 装配根是**唯一** import 具体实现的地方。此后运行期各模块只面向接口协作。
