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

### 3.1 BaseCLIAdapter（`cli/base.ts`）

```typescript
export interface BaseCLIAdapter {
  readonly cliType: CliType;

  start(opts: SpawnOptions): Promise<void>;
  stop(): Promise<void>;
  sendInput(data: string): void;             // 向 PTY 注入（含 "y\r" / "n\r"）
  interrupt(): void;                         // Ctrl+C
  resize(cols: number, rows: number): void;
  getState(): AdapterState;
  onData(handler: (chunk: string) => void): Unsubscribe;
}

export interface SpawnOptions {
  conversationId: ConversationId;
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export type AdapterState = 'stopped' | 'starting' | 'ready' | 'busy' | 'waitingApproval';
```

### 3.2 Runtime（`runtime/`）—— Adapter 的底层容器，对 Core 透明

```typescript
export interface Runtime {
  spawn(opts: SpawnOptions): Promise<void>;
  write(data: string): void;
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (chunk: string) => void): Unsubscribe;
  onExit(handler: (code: number | null) => void): Unsubscribe;
}
// V1 实现：NodePtyRuntime。未来可替换为 SdkRuntime，Adapter 不感知。
```

### 3.3 ApprovalDetector（`approval/`）—— 各 Adapter 自持，抛统一事件

```typescript
export interface ApprovalDetector {
  // 从 PTY 输出流中检测审批点；命中返回结构化事件，否则 null
  detect(chunk: string, buffer: string): ApprovalSignal | null;
}

export interface ApprovalSignal {
  command: string;   // 提取到的待审批命令
  detail: string;    // 上下文
}
// 例：ClaudeApprovalDetector 用正则匹配 [Y/n]；SDK 模式解析 Tool Call。
// Adapter 命中后 → bus.emit('ApprovalRequested', { approvalId, command, detail, ... })
```

---

## 4. Message Aggregator（`core/aggregator.ts` 或独立）

PTY 高频输出 → 缓冲/去抖/限流 → 发 `MessageGenerated`。

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
core.registerAdapter(new ClaudeCLIAdapter(/* runtime */));
createMemoryModule({ bus, repos, config });      // 订阅事件，无需 Core 感知

const telegram = new TelegramTransport({ bus, config });
await telegram.start();
```

> 装配根是**唯一** import 具体实现的地方。此后运行期各模块只面向接口协作。
