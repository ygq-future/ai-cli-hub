/**
 * audit_logs —— 审批留痕（永久，不可删；docs/04-Data-Model.md §5）。
 * 强约束：conversationId 不 cascade delete —— 会话归档后审计仍在。
 * Repository 不提供 delete 方法。
 */
import { pgTable, text, bigint, index } from 'drizzle-orm/pg-core'
import { approvalActionEnum } from './enums'
import { conversations } from './conversations'

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id), // 注意：不 onDelete cascade
    command: text('command').notNull(),
    action: approvalActionEnum('action').notNull(),
    operator: text('operator').notNull(), // 决策人 userId
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  t => [index('idx_audit_conv').on(t.conversationId, t.createdAt)],
)

export type AuditLog = typeof auditLogs.$inferSelect
export type NewAuditLog = typeof auditLogs.$inferInsert
