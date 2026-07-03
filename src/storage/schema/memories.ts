/**
 * memories —— 长期记忆（两层 + 向量预留 + 遗忘三件套；docs/04-Data-Model.md §6）。
 * conversationId = NULL → user-level（画像/偏好）；填值 → conversation-level（情节摘要）。
 * embedding：V1 建列不建索引、留空；V1.5 回填并追加 HNSW 迁移。
 */
import { sql } from 'drizzle-orm'
import { pgTable, text, bigint, real, integer, index, customType } from 'drizzle-orm/pg-core'
import { memoryTypeEnum } from './enums'
import { conversations } from './conversations'

/**
 * pgvector 自定义列（维度对齐 text-embedding-3-small = 1536）。
 * toDriver：number[] → pgvector 文本字面量 `[a,b,c]`（Postgres 侧 text→vector 隐式转换）。
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(1536)'
  },
  toDriver(value) {
    return `[${value.join(',')}]`
  },
})

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(), // 用户级记忆锚点
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }), // 可空：NULL = user-level
    type: memoryTypeEnum('type').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding'), // V1 可 NULL，V1.5 填充
    sourceMessageId: text('source_message_id'),
    importance: real('importance').notNull().default(0.5),
    accessCount: integer('access_count').notNull().default(0),
    lastAccessedAt: bigint('last_accessed_at', { mode: 'number' }),
    tag: text('tag'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  t => [
    index('idx_mem_user').on(t.userId, t.type),
    index('idx_mem_conv').on(t.conversationId),
    // V1：全文检索（关系 + FTS 回放）
    index('idx_mem_fts').using('gin', sql`to_tsvector('simple', ${t.content})`),
    // V1.5：向量近邻索引（HNSW）在启用时追加独立迁移，见 docs/04 §8
  ],
)

export type Memory = typeof memories.$inferSelect
export type NewMemory = typeof memories.$inferInsert
