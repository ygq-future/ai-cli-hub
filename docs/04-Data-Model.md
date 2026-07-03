# 04 - 数据模型（Data Model）

> Drizzle schema 的**唯一真相源**。建表、迁移、索引以本文件为准。
> 类型经 `$inferSelect` / `$inferInsert` 导出到 [03-契约 §5](./03-Interface-Contracts.md)。ER 概览见 [02-架构 §6](./02-Architecture.md)。
> 数据库：**Postgres**；向量：**pgvector**（V1 预留列，V1.5 启用索引）。

---

## 1. 约定

- 主键 `id`：`text`，应用层生成（`crypto.randomUUID()` 或 ULID），便于分布式与测试。
- 时间戳：`bigint`（epoch ms），统一由应用写入，避免时区问题。
- 命名：表名复数 `snake_case`；列名 `snake_case`；TS 侧驼峰由 Drizzle 映射。
- 所有外键带索引；高频查询列建复合索引（见 §7）。

---

## 2. 扩展与枚举

```sql
-- 迁移最前置：启用向量扩展（V1 即建，索引 V1.5 再加）
CREATE EXTENSION IF NOT EXISTS vector;
```

```typescript
// storage/schema/enums.ts
import { pgEnum } from 'drizzle-orm/pg-core';

export const platformEnum      = pgEnum('platform', ['telegram', 'qq', 'websocket']);
export const cliEnum           = pgEnum('cli', ['claude', 'codex', 'gemini']);
export const sessionStatusEnum = pgEnum('session_status',
  ['idle', 'starting', 'running', 'waitingApproval', 'closing', 'closed']);
export const roleEnum          = pgEnum('role', ['user', 'assistant', 'system']);
export const memoryTypeEnum    = pgEnum('memory_type', ['episodic', 'semantic', 'preference']);
export const approvalActionEnum= pgEnum('approval_action', ['approve', 'reject']);
```

---

## 3. `conversations` — 会话元数据

```typescript
// storage/schema/conversations.ts
import { pgTable, text, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { platformEnum, cliEnum, sessionStatusEnum } from './enums';

export const conversations = pgTable('conversations', {
  id:         text('id').primaryKey(),
  platform:   platformEnum('platform').notNull(),
  userId:     text('user_id').notNull(),
  cli:        cliEnum('cli').notNull(),
  cwd:        text('cwd').notNull(),                       // 会话边界：项目目录
  status:     sessionStatusEnum('status').notNull().default('idle'),
  createdAt:  bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:  bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => ({
  // 会话边界定位：(user, cli, cwd) 唯一活跃会话。见 02-架构 §5.1
  activeLookup: index('idx_conv_active').on(t.userId, t.cli, t.cwd, t.status),
  // 归档扫描：按 status + updatedAt
  archiveScan:  index('idx_conv_archive').on(t.status, t.updatedAt),
}));

export type Conversation    = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
```

> 边界规则：`findActive(userId, cli, cwd)` 命中 `status ∈ {idle, running, ...非 closed}` 的记录即复用；`/new` 先把旧活跃会话置 `idle` 再插新记录。

---

## 4. `messages` — 完整对话记录

```typescript
// storage/schema/messages.ts
import { pgTable, text, bigint, index } from 'drizzle-orm/pg-core';
import { roleEnum } from './enums';
import { conversations } from './conversations';

export const messages = pgTable('messages', {
  id:             text('id').primaryKey(),
  conversationId: text('conversation_id').notNull()
                    .references(() => conversations.id, { onDelete: 'cascade' }),
  role:           roleEnum('role').notNull(),
  content:        text('content').notNull(),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => ({
  byConv: index('idx_msg_conv').on(t.conversationId, t.createdAt),
}));

export type Message    = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
```

---

## 5. `audit_logs` — 审批留痕（永久，不可删）

```typescript
// storage/schema/audit-logs.ts
import { pgTable, text, bigint, index } from 'drizzle-orm/pg-core';
import { approvalActionEnum } from './enums';
import { conversations } from './conversations';

export const auditLogs = pgTable('audit_logs', {
  id:             text('id').primaryKey(),
  conversationId: text('conversation_id').notNull()
                    .references(() => conversations.id),   // 注意：不 cascade delete，审计不随会话删除
  command:        text('command').notNull(),
  action:         approvalActionEnum('action').notNull(),
  operator:       text('operator').notNull(),              // 决策人 userId
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => ({
  byConv: index('idx_audit_conv').on(t.conversationId, t.createdAt),
}));

export type AuditLog    = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
```

> **强约束**：不提供 delete 方法；`conversationId` 不设 `onDelete: cascade`，保证会话归档后审计仍在。

---

## 6. `memories` — 长期记忆（两层 + 向量 + 遗忘）

```typescript
// storage/schema/memories.ts
import { pgTable, text, bigint, real, integer, index, customType } from 'drizzle-orm/pg-core';
import { memoryTypeEnum } from './enums';
import { conversations } from './conversations';

// pgvector 自定义列（维度对齐 text-embedding-3-small = 1536）
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() { return 'vector(1536)'; },
  toDriver(v) { return `[${v.join(',')}]`; },
});

export const memories = pgTable('memories', {
  id:              text('id').primaryKey(),
  userId:          text('user_id').notNull(),               // 用户级记忆锚点
  conversationId:  text('conversation_id')                  // 可空：NULL=user-level
                     .references(() => conversations.id, { onDelete: 'set null' }),
  type:            memoryTypeEnum('type').notNull(),
  content:         text('content').notNull(),
  embedding:       vector('embedding'),                     // V1 可 NULL，V1.5 填充
  sourceMessageId: text('source_message_id'),
  importance:      real('importance').notNull().default(0.5),
  accessCount:     integer('access_count').notNull().default(0),
  lastAccessedAt:  bigint('last_accessed_at', { mode: 'number' }),
  tag:             text('tag'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => ({
  byUser: index('idx_mem_user').on(t.userId, t.type),
  byConv: index('idx_mem_conv').on(t.conversationId),
  // V1：全文检索（关系 + FTS 回放）
  fts: index('idx_mem_fts').using('gin', sql`to_tsvector('simple', ${t.content})`),
  // V1.5：向量近邻索引（启用时追加迁移）
  // vec: index('idx_mem_vec').using('hnsw', t.embedding.op('vector_cosine_ops')),
}));

export type Memory    = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
```

> `conversationId` = NULL → user-level（画像/偏好）；填值 → conversation-level（情节摘要）。
> 遗忘三件套 `importance / accessCount / lastAccessedAt` 支撑衰减清理，见 [06-记忆设计](./06-Memory-Design.md)。

---

## 7. 索引总览

| 表 | 索引 | 服务查询 |
|---|---|---|
| conversations | `(user_id, cli, cwd, status)` | 会话边界定位（复用/新建） |
| conversations | `(status, updated_at)` | 归档扫描 `listStaleIdle` |
| messages | `(conversation_id, created_at)` | 上下文恢复 |
| audit_logs | `(conversation_id, created_at)` | 审计查询 |
| memories | `(user_id, type)` | user-level 取回 |
| memories | GIN FTS on `content` | V1 关键词召回 |
| memories | HNSW on `embedding` | V1.5 向量召回 |

---

## 8. 迁移策略（Drizzle Kit）

```bash
bun run db:generate    # 依据 schema 生成 SQL 迁移到 drizzle/
bun run db:migrate     # 应用迁移
```

- **迁移 0001**：`CREATE EXTENSION vector` + 四表 + 除 HNSW 外全部索引。`embedding` 列建但不建向量索引。
- **迁移 00xx（V1.5）**：回填 `embedding` 后 `CREATE INDEX ... USING hnsw`。分开是因为 HNSW 建索引需数据先就位且耗时。

> `sql` 需 `import { sql } from 'drizzle-orm'`。向量维度若换嵌入模型需同步调整 `vector(N)` 与索引。
