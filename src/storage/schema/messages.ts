/**
 * messages —— 完整对话记录（docs/04-Data-Model.md §4）。
 * conversationId 级联删除：会话删除时消息随之清理。
 */
import { pgTable, text, bigint, index, jsonb, boolean, uniqueIndex } from 'drizzle-orm/pg-core'
import type { StoredMessageAttachment } from '../../shared'
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
    attachments: jsonb('attachments').$type<StoredMessageAttachment[]>().notNull().default([]),
    contextEligible: boolean('context_eligible').notNull().default(true),
    messageType: messageTypeEnum('message_type').notNull().default('chat'),
    auditLogId: text('audit_log_id').references(() => auditLogs.id),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  t => [index('idx_msg_conv').on(t.conversationId, t.createdAt), uniqueIndex('uniq_msg_audit_log').on(t.auditLogId)],
)

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
