/**
 * conversation_files —— 会话内暂存文件映射。
 *
 * sequence 是 conversation 维度的用户可见文件编号，从 1 开始；会话清空或关闭后，
 * 映射与对应临时文件一起删除，下一轮重新计数。
 */
import { pgTable, text, bigint, integer, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { conversations } from './conversations'

export const conversationFiles = pgTable(
  'conversation_files',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    kind: text('kind').notNull(),
    fileId: text('file_id'),
    fileName: text('file_name'),
    mimeType: text('mime_type'),
    fileSize: bigint('file_size', { mode: 'number' }),
    localPath: text('local_path').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  table => [
    uniqueIndex('uniq_conversation_file_sequence').on(table.conversationId, table.sequence),
    index('idx_conversation_file_recent').on(table.conversationId, table.createdAt),
  ],
)

export type ConversationFile = typeof conversationFiles.$inferSelect
export type NewConversationFile = typeof conversationFiles.$inferInsert
