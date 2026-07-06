/**
 * memories —— 长期记忆（实例级 namespace + 向量预留 + 遗忘三件套；docs/04-Data-Model.md §6）。
 * namespace = global → 当前 AI Hub 实例共享记忆池。
 * conversationId = NULL → 全局事实/偏好/环境；填值 → 会话产出的情节摘要。
 * embedding：V1 建列不建索引、留空；V1.5 回填并追加 HNSW 迁移。
 */
import { sql } from 'drizzle-orm'
import { pgTable, text, bigint, real, integer, index, uniqueIndex, customType } from 'drizzle-orm/pg-core'
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
    namespace: text('namespace').notNull().default('global'), // 实例级记忆命名空间
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }), // 可空：NULL = 全局事实/偏好/环境
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
    index('idx_mem_namespace').on(t.namespace, t.type),
    uniqueIndex('uniq_mem_tag').on(t.namespace, t.tag),
    index('idx_mem_conv').on(t.conversationId),
    // 全文检索预留；后续与语义召回结合。
    index('idx_mem_fts').using('gin', sql`to_tsvector('simple', ${t.content})`),
    // V1.5：向量近邻索引（HNSW）在启用时追加独立迁移，见 docs/04 §8
  ],
)

export type Memory = typeof memories.$inferSelect
export type NewMemory = typeof memories.$inferInsert
