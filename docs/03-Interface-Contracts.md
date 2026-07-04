# 03 - 接口契约（Interface Contracts）

> 本文件是所有模块间**契约的唯一真相源**。实现任何 Transport / Adapter / Repository 前，严格按此签名，不擅自改动。
> 与 [02-架构](./02-Architecture.md) 对应；数据表见 [04-数据模型](./04-Data-Model.md)。
>
> 约定：所有接口最终落在 `src/shared/types/`（纯类型，叶子模块），实现分散在各业务目录。

---

## 0. 基础类型（`shared/types/common.ts`）

```typescript
export type Platform = 'telegram' | 'qq' | 'websocket';
export type CliType = 'claude' | 'codex' | 'gemini';

// 会话状态（对应 02-架构 §5.2 状态机）
export type SessionStatus =
  | 'idle'            // 无活跃进程，可唤醒
  | 'starting'        // 正在拉起 Runtime
  | 'running'         // 交互中
  | 'waitingApproval' // 等待人工审批
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
  SessionClosed:    { conversationId: ConversationId; reason: 'user' | 'archiveTimeout' };

  // —— 消息 ——
  MessageReceived:  { conversationId: ConversationId; userId: string; platform: Platform; text: string; ref: MessageRef };
  MessageGenerated: { conversationId: ConversationId; content: string; final: boolean }; // final=false 为流式增量

  // —— 审批（Human-in-the-loop）——
  ApprovalRequested: { conversationId: ConversationId; approvalId: string; command: string; detail: string };
  ApprovalApproved:  { conversationId: ConversationId; approvalId: string; operator: string };
  ApprovalRejected:  { conversationId: ConversationId; approvalId: string; operator: string };

  // —— 进程 ——
  PTYStarted: { conversationId: ConversationId; pid: number };
  PTYExited:  { conversationId: ConversationId; code: number | null; reason: 'idleTimeout' | 'crash' | 'stop' };

  // —— 记忆 ——
  MemoryUpdated: { conversationId: ConversationId | null; userId: string; memoryType: MemoryType; memoryId: string };

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
> - **SDK 家族（Claude 等提供 Agent SDK 的 CLI，V1 首选）**：`ClaudeSdkAdapter` 内部持 `@anthropic-ai/claude-agent-sdk` 的 `query()` 句柄。输出来自结构化 `SDKMessage`，**审批来自 `canUseTool` 回调**（拿到工具名 + 完整参数），无需 scraping、无 `Runtime`、无 `ApprovalDetector`。
> - **PTY 家族（无 SDK 的 CLI 备用）**：`XxxPtyAdapter` 内部持 `PtyRuntime`（§3.2）+ 一个 per-CLI `ApprovalDetector`（§3.3）。字节流剥 ANSI 得输出，正则 scraping 认出审批点。**这些脏活被关在 Adapter 内部，不外泄。**

### 3.1 CLIAdapter（`cli/base.ts`）—— Core / Transport 唯一依赖的语义抽象

```typescript
export interface CLIAdapter {
  readonly cliType: CliType;

  start(opts: SpawnOptions): Promise<void>;
  stop(): Promise<void>;
  interrupt(): void;                                  // Ctrl+C / query.interrupt()

  sendUserInput(text: string): void;                  // 一轮用户输入（字符串在两家族天然成立，非 PTY 泄漏）

  onOutput(handler: (delta: OutputDelta) => void): Unsubscribe;         // 流式助手输出（语义，非裸字节）
  onApprovalRequest(handler: (req: ApprovalRequest) => void): Unsubscribe;
  resolveApproval(approvalId: string, decision: ApprovalAction): void;  // 'approve' | 'reject'
  onExit(handler: (info: ExitInfo) => void): Unsubscribe;

  getState(): AdapterState;
}

export interface OutputDelta {
  text: string;
  final: boolean;    // false=流式增量，true=一轮结束
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
}

export type AdapterState = 'stopped' | 'starting' | 'ready' | 'busy' | 'waitingApproval';
```

> **事件映射（EventMap 不变）**：Adapter 的 `onApprovalRequest` → `bus.emit('ApprovalRequested', { approvalId, command, detail, conversationId })`；Transport 的 [Approve]/[Reject] → `bus.emit('ApprovalApproved'|'ApprovalRejected')` → Core 调 `adapter.resolveApproval(id, 'approve'|'reject')`。SDK 家族据此 `resolve({ behavior: 'allow'|'deny' })`；PTY 家族据此 `runtime.write("y\r"|"n\r")`。

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
  findActive(userId: string, cli: CliType, cwd: string): Promise<Conversation | null>;
  findById(id: ConversationId): Promise<Conversation | null>;
  updateStatus(id: ConversationId, status: SessionStatus): Promise<void>;
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

export interface MemoryRepository {
  insert(m: NewMemory): Promise<Memory>;
  // V1：关系 + FTS 检索
  searchByKeyword(userId: string, query: string, topK: number): Promise<Memory[]>;
  listUserLevel(userId: string): Promise<Memory[]>;
  // V1.5：向量检索（embedding 非空时启用）
  searchByVector(userId: string, embedding: number[], topK: number): Promise<Memory[]>;
  touch(id: string): Promise<void>; // access_count++ / last_accessed_at
}
```

> `New*` 为插入用类型（无 id/时间戳），`Conversation`/`Message`/... 为读取用完整类型，均由 Drizzle `$inferInsert` / `$inferSelect` 推导，见 04。

---

## 6. Config（`config/`）—— 唯一读 env 的地方

```typescript
import { z } from 'zod';

export const ConfigSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  WHITELIST_USER_IDS: z.string().transform(s => s.split(',').map(x => x.trim())),

  DATABASE_URL: z.string().url(),                 // postgres://...

  EMBEDDING_API_KEY: z.string().min(1),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  MEMORY_RECALL_TOP_K: z.coerce.number().default(6),

  PTY_IDLE_TIMEOUT_MS: z.coerce.number().default(300_000),
  SESSION_ARCHIVE_DAYS: z.coerce.number().default(7),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    // fail-fast：启动即报错，不允许运行期"配置未定义"
    throw new Error(`Invalid config:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
```

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
createMemoryModule({ bus, repos, config });      // 订阅事件，无需 Core 感知

const telegram = new TelegramTransport({ bus, config });
await telegram.start();
```

> 装配根是**唯一** import 具体实现的地方。此后运行期各模块只面向接口协作。
