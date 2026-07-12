// storage —— Postgres/Drizzle 连接、schema、迁移（pgvector）。唯一 SQL 实现处。
// 禁止依赖任何业务模块（见 CLAUDE.md 依赖矩阵）。
export { closeDb, createDb } from './db'
export type { Db } from './db'
export * as schema from './schema'
export type {
  Conversation,
  NewConversation,
  Message,
  NewMessage,
  AuditLog,
  NewAuditLog,
  Memory,
  NewMemory,
  UserPreference,
  UserCliCwd,
} from './schema'
