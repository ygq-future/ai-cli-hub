/**
 * messages —— 完整对话记录（docs/04-Data-Model.md §4）。
 * conversationId 级联删除：会话删除时消息随之清理。
 */
import { pgTable, text, bigint, index } from 'drizzle-orm/pg-core'
import { roleEnum } from './enums'
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
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  t => [index('idx_msg_conv').on(t.conversationId, t.createdAt)],
)

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
