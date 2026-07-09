/**
 * MemoryRepository —— Drizzle 实现（docs/03 §5 / docs/04 §6）。
 * V1：关系 + FTS 关键词召回；V1.5：pgvector 近邻召回。
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../storage'
import { memories } from '../storage/schema'
import type { MemoryRepository, Memory, NewMemory } from './types'

export function createMemoryRepository(db: Db): MemoryRepository {
  return {
    async insert(m: NewMemory): Promise<Memory> {
      const [row] = await db.insert(memories).values(m).returning()
      if (!row) throw new Error('MemoryRepository.insert: 插入未返回行')
      return row
    },

    async upsertByTag(
      namespace: string,
      tag: string,
      m: Omit<NewMemory, 'id' | 'namespace' | 'tag' | 'createdAt'>,
    ): Promise<Memory> {
      const now = Date.now()
      const [row] = await db
        .insert(memories)
        .values({
          ...m,
          id: crypto.randomUUID(),
          namespace,
          tag,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [memories.namespace, memories.tag],
          set: {
            conversationId: m.conversationId,
            type: m.type,
            content: m.content,
            embedding: m.embedding,
            sourceMessageId: m.sourceMessageId,
            importance: m.importance,
          },
        })
        .returning()
      if (!row) throw new Error('MemoryRepository.upsertByTag: 写入未返回行')
      return row
    },

    listGlobal(namespace: string): Promise<Memory[]> {
      // 全局事实 = conversationId 为 NULL；启动时全量注入。
      return db
        .select()
        .from(memories)
        .where(and(eq(memories.namespace, namespace), isNull(memories.conversationId)))
    },

    async findById(id: string): Promise<Memory | null> {
      const [row] = await db.select().from(memories).where(eq(memories.id, id)).limit(1)
      return row ?? null
    },

    searchByKeyword(namespace: string, query: string, topK: number): Promise<Memory[]> {
      // GIN FTS（idx_mem_fts）：simple 配置，按 ts_rank 排序取 Top-K。
      const tsv = sql`to_tsvector('simple', ${memories.content})`
      const tsq = sql`plainto_tsquery('simple', ${query})`
      return db
        .select()
        .from(memories)
        .where(and(eq(memories.namespace, namespace), sql`${tsv} @@ ${tsq}`))
        .orderBy(sql`ts_rank(${tsv}, ${tsq}) DESC`)
        .limit(topK)
    },

    searchByVector(namespace: string, embedding: number[], topK: number): Promise<Memory[]> {
      const queryVector = `[${embedding.join(',')}]`
      return db
        .select()
        .from(memories)
        .where(and(eq(memories.namespace, namespace), isNotNull(memories.embedding)))
        .orderBy(sql`${memories.embedding} <=> ${queryVector}::vector`)
        .limit(topK)
    },

    async setEmbedding(id: string, embedding: number[]): Promise<void> {
      await db.update(memories).set({ embedding }).where(eq(memories.id, id))
    },

    async touch(id: string): Promise<void> {
      await db
        .update(memories)
        .set({
          accessCount: sql`${memories.accessCount} + 1`,
          lastAccessedAt: Date.now(),
        })
        .where(eq(memories.id, id))
    },

    async delete(id: string): Promise<void> {
      await db.delete(memories).where(eq(memories.id, id))
    },
  }
}
