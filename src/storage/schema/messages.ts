/**
 * messages —— 完整对话记录（docs/04-Data-Model.md §4）。
 * conversationId 级联删除：会话删除时消息随之清理。
 */
import { sql } from 'drizzle-orm'
import { pgTable, text, bigint, index, boolean, uniqueIndex, check } from 'drizzle-orm/pg-core'
import type { StoredMessageAttachment } from '../../shared'
import { bunJsonb } from './bun-jsonb'
import { messageTypeEnum, roleEnum } from './enums'
import { auditLogs } from './audit-logs'
import { conversations } from './conversations'

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    content: text('content').notNull(),
    attachments: bunJsonb<StoredMessageAttachment[]>('attachments').notNull().default([]),
    contextEligible: boolean('context_eligible').notNull().default(true),
    messageType: messageTypeEnum('message_type').notNull().default('chat'),
    auditLogId: text('audit_log_id').references(() => auditLogs.id, { onDelete: 'set null' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  t => [
    index('idx_msg_conv').on(t.conversationId, t.createdAt),
    uniqueIndex('uniq_msg_audit_log').on(t.auditLogId),
    check('messages_attachments_array', sql`jsonb_typeof(${t.attachments}) = 'array'`),
  ],
)

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
