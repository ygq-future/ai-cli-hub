/**
 * ConversationFileRepository —— 会话内文件映射的 Drizzle 实现。
 */
import { and, desc, eq, ilike, max, sql } from 'drizzle-orm'
import type { Db } from '../storage'
import { conversationFiles } from '../storage/schema'
import type { ConversationFileRepository, ConversationFile } from './types'

export function createConversationFileRepository(db: Db): ConversationFileRepository {
  return {
    async createNext(input): Promise<ConversationFile> {
      return db.transaction(async tx => {
        // 同一 conversation 的并发附件上传必须串行分配编号。
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.conversationId}))`)
        const [latest] = await tx
          .select({ sequence: max(conversationFiles.sequence) })
          .from(conversationFiles)
          .where(eq(conversationFiles.conversationId, input.conversationId))
        const [row] = await tx
          .insert(conversationFiles)
          .values({
            ...input,
            id: crypto.randomUUID(),
            sequence: (latest?.sequence ?? 0) + 1,
            createdAt: Date.now(),
          })
          .returning()
        if (!row) throw new Error('ConversationFileRepository.createNext: 插入未返回行')
        return row
      })
    },

    async findBySequence(conversationId, sequence): Promise<ConversationFile | null> {
      const [row] = await db
        .select()
        .from(conversationFiles)
        .where(and(eq(conversationFiles.conversationId, conversationId), eq(conversationFiles.sequence, sequence)))
        .limit(1)
      return row ?? null
    },

    listByConversation(conversationId, limit, keyword): Promise<ConversationFile[]> {
      const where = keyword
        ? and(eq(conversationFiles.conversationId, conversationId), ilike(conversationFiles.fileName, `%${keyword}%`))
        : eq(conversationFiles.conversationId, conversationId)
      return db
        .select()
        .from(conversationFiles)
        .where(where)
        .orderBy(desc(conversationFiles.createdAt), desc(conversationFiles.sequence))
        .limit(limit)
    },

    async deleteByConversation(conversationId): Promise<ConversationFile[]> {
      return db.delete(conversationFiles).where(eq(conversationFiles.conversationId, conversationId)).returning()
    },
  }
}
