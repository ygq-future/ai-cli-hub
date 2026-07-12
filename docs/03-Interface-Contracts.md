# 03 - 接口契约（Interface Contracts）

> 本文件是所有模块间**契约的唯一真相源**。实现任何 Transport / Adapter / Repository 前，严格按此签名，不擅自改动。
> 与 [02-架构](./02-Architecture.md) 对应；数据表见 [04-数据模型](./04-Data-Model.md)。
>
> 约定：所有接口最终落在 `src/shared/types/`（纯类型，叶子模块），实现分散在各业务目录。

---

## 0. 基础类型（`shared/types/common.ts`）

```typescript
export type Platform = 'telegram' | 'qq' | 'websocket';
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

  // —— 消息 ——
  MessageReceived:  { userId: string; platform: Platform; cli: CliType; cwd: string; text: string; ref: MessageRef };
  // M9: emoji/sticker/file/photo 在 Transport 层预处理后仍折入 text；Core 不感知平台媒体结构。
  MessageGenerated: { conversationId: ConversationId; content: string; final: boolean }; // final=false 为流式增量
  CommandReply:     { ref: MessageRef; content: string };
  UserLanguageChanged: { userId: string; platform: Platform; language: 'zh' | 'en' };
  UserTargetChanged: { userId: string; platform: Platform; cli?: CliType; cwd?: string }; // /cwd 等只切当前 scope 的目标边界、不创建 conversation

  // —— 审批（Human-in-the-loop）——
  ApprovalRequested: { conversationId: ConversationId; approvalId: string; command: string; detail: string; autoApproveAt?: number; autoApproveSeconds?: number };
  ApprovalApproved:  { conversationId: ConversationId; approvalId: string; operator: string; automatic?: boolean };
  ApprovalRejected:  { conversationId: ConversationId; approvalId: string; operator: string };

  // —— 进程 ——
  PTYStarted: { conversationId: ConversationId; pid: number };
  PTYExited:  { conversationId: ConversationId; code: number | null; reason: 'idleTimeout' | 'crash' | 'stop' };

  // —— 记忆 ——
  MemoryUpdated: {
    conversationId: ConversationId | null;
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
> - **SDK 家族（Claude/opencode 等提供 SDK 的 CLI，首选）**：`ClaudeSdkAdapter` 内部持 `@anthropic-ai/claude-agent-sdk` 的 `query()` 句柄；`OpenCodeSdkAdapter` 通过 `@opencode-ai/sdk` 拉起 `opencode serve` 并订阅 SSE 事件。输出来自结构化消息/事件，审批来自 SDK 回调或 permission 事件，无需 scraping、无 `Runtime`、无 `ApprovalDetector`。OpenCode text/tool part 只有在其 `messageID` 已由 `message.updated.info.role` 确认为 assistant 时才可转成 `OutputDelta`；user/noReply context part 必须丢弃。
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
}

export type AdapterState = 'stopped' | 'starting' | 'ready' | 'busy' | 'waitingApproval';
```

> **事件映射（EventMap 不变）**：Adapter 的 `onApprovalRequest` → `bus.emit('ApprovalRequested', { approvalId, command, detail, conversationId })`；Transport 的 [Approve]/[Reject] → `bus.emit('ApprovalApproved'|'ApprovalRejected')` → Core 调 `adapter.resolveApproval(id, 'approve'|'reject')`。SDK 家族据此 `resolve({ behavior: 'allow'|'deny' })`；PTY 家族据此 `runtime.write("y\r"|"n\r")`。

> **共享只读查询策略**：所有 CLI Adapter 必须复用 `cli/utils.isReadOnlyShellCommand`。仅单条、明确的 POSIX/cmd/PowerShell 查询可免审批；含重定向、管道、串联、命令替换或未知/写操作时返回 false。Claude 在 `canUseTool(Bash)` 放行，OpenCode 在 `permission=bash` 时直接 reply `once`。

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
// V1 实现：NodePtyRuntime。
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
  // scope=(platform,userId) 内最新会话未 closing/closed 时复用；CLI/cwd 不参与 scope。
  findActive(platform: Platform, userId: string): Promise<Conversation | null>;
  // scope 内最新可复用会话；用于进程重启后恢复内存目标并复用 idle，不返回 closing/closed。
  findLatestOpenByUser(platform: Platform, userId: string): Promise<Conversation | null>;
  // scope 内最近任意会话；没有 open 会话时恢复持久 target cli。
  findLatestByUser(platform: Platform, userId: string): Promise<Conversation | null>;
  findById(id: ConversationId): Promise<Conversation | null>;
  // scope 内所有非 closed 会话；新建会话前兜底关闭历史残留。
  listOpenByUser(platform: Platform, userId: string): Promise<Conversation[]>;
  listRecentByUser(platform: Platform, userId: string, limit: number): Promise<Conversation[]>;
  updateStatus(id: ConversationId, status: SessionStatus): Promise<void>;
  // 进程重启对账：starting/running 复位 idle，closing 收尾 closed。
  reconcileRuntimeStatuses(now: number): Promise<void>;
  listStaleIdle(beforeTs: number): Promise<Conversation[]>; // 归档扫描
}

export interface MessageRepository {
  append(m: NewMessage): Promise<Message>;
  listByConversation(id: ConversationId, limit?: number): Promise<Message[]>;
}

export interface AuditRepository {
  record(a: NewAuditLog): Promise<void>;          // 永久，不可删
  listByConversation(id: ConversationId): Promise<AuditLog[]>;
}

// 审计范围：记录手动与自动 Approval 决议；自动操作人格式为 auto:<userId>。
// audit_logs.command 写入工具/命令名、approvalId 与请求详情的可读文本；
// /audit [conversationId] 通过 listByConversation 查看最近审批记录。

export interface MemoryRepository {
  insert(m: NewMemory): Promise<Memory>;
  // M8：环境快照等稳定 tag 记忆幂等写入；同 namespace+tag 存在则更新 content/type/importance。
  upsertByTag(namespace: string, tag: string, m: Omit<NewMemory, 'id' | 'namespace' | 'tag' | 'createdAt'>): Promise<Memory>;
  // 实例级全局记忆：conversationId 为 NULL，启动时全量注入，不受 MEMORY_RECALL_TOP_K 限制。
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
  findCwd(platform: Platform, userId: string, cli: CliType): Promise<UserCliCwd | null>;
  upsertCwd(platform: Platform, userId: string, cli: CliType, cwd: string): Promise<void>;
}
```

`UserPreferenceRepository` 是用户级持久化目标的唯一 SQL 出口：按 `(platform,userId)` 保存 `/lang`、默认 CLI 与自动审批开关，并按 `(platform,userId,cli)` 保存 cwd；不使用无类型的通用 KV 表。

> `New*` 为插入用类型（无 id/时间戳），`Conversation`/`Message`/... 为读取用完整类型，均由 Drizzle `$inferInsert` / `$inferSelect` 推导，见 04。

---

## 6. Config（`config/`）—— `settings.json` 唯一业务配置源

`SettingsJsonSchema` 使用 Zod 校验 `settings.json` 的 13 个嵌套分类，`loadConfig()` 在启动时 fail-fast，再展平为现有消费者使用的 `AppConfig`。

```typescript
export type SettingsJson = z.infer<typeof SettingsJsonSchema>;

export function loadConfig(
  source?: Partial<SettingsJson>,
  opts?: { settingsPath?: string },
): AppConfig;
```

- 默认读取项目根目录 `settings.json`；该文件 gitignore，模板为 `settings.json.example`。
- `bun run setting:migrate` 只对齐 JSON key 结构，不读取 `.env`。
- 数据库的 host/port/db/username/password 被组装为兼容字段 `AppConfig.DATABASE_URL`；`db:migrate` 与主进程使用同一配置。
- 代理配置会写回 `process.env.HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`，仅用于 Bun fetch 和 SDK 子进程继承；`process.env` 不是业务配置输入源。
- `/update confirm` 依次执行 git pull、bun install、`setting:migrate`、`db:migrate`、format check、typecheck 和 lint；任一步失败都不安排重启。

---

## 7. Composition Root（`main.ts`）装配顺序

```typescript
const config = loadConfig();
const logger = createLogger(config);
const bus = createEventBus();

const db = createDb(config.DATABASE_URL);        // storage/
const repos = createRepositories(db);            // repository/

const core = createCoreHub({ bus, repos, config });   // 注入抽象
core.registerAdapter(new ClaudeSdkAdapter({ bus, config })); // SDK 家族，内部持 query()，无需 runtime
core.registerAdapter(new OpenCodeSdkAdapter({ bus, config })); // SDK 家族，内部持 opencode server/client，审批经 permission 事件
createMemoryModule({ bus, repos, config });      // 订阅事件，无需 Core 感知

const transports = [
  config.TELEGRAM_BOT_TOKEN && new TelegramTransport({ bus, config }),
  config.QQBOT_APP_ID && new QQTransport({ bus, config }),
].filter(Boolean);
await Promise.all(transports.map(transport => transport.start()));
```

> 装配根是**唯一** import 具体实现的地方。此后运行期各模块只面向接口协作。
