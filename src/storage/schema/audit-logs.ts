/**
 * audit_logs —— 审批留痕（永久，不可删；docs/04-Data-Model.md §5）。
 * 会话硬删除时随 conversation cascade；Repository 不提供单条 audit delete 方法。
 */
import { sql } from 'drizzle-orm'
import { pgTable, text, bigint, index, boolean, uniqueIndex, check } from 'drizzle-orm/pg-core'
import type { ApprovalAuditRequest } from '../../shared'
import { bunJsonb } from './bun-jsonb'
import { approvalStatusEnum } from './enums'
import { conversations } from './conversations'

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    approvalId: text('approval_id').notNull(),
    request: bunJsonb<ApprovalAuditRequest>('request').notNull(),
    status: approvalStatusEnum('status').notNull().default('pending'),
    operator: text('operator'), // pending 时为空；决议后为 userId 或 auto:userId
    automatic: boolean('automatic').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  t => [
    index('idx_audit_conv').on(t.conversationId, t.createdAt),
    index('idx_audit_global_order').on(t.createdAt, t.id),
    uniqueIndex('uniq_audit_conversation_approval').on(t.conversationId, t.approvalId),
    check('audit_logs_request_object', sql`jsonb_typeof(${t.request}) = 'object'`),
  ],
)

export type AuditLog = typeof auditLogs.$inferSelect
export type NewAuditLog = typeof auditLogs.$inferInsert
