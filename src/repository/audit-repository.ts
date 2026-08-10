/**
 * AuditRepository —— Drizzle 实现（docs/03 §5 / docs/04 §5）。
 * 永久留痕：创建、终态更新与查询，无 delete（强约束）。
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../storage'
import { auditLogs, messages } from '../storage/schema'
import type { AuditRepository, AuditLog, ConversationId } from './types'

export function createAuditRepository(db: Db): AuditRepository {
  return {
    async createPending(audit, timelineMessage): Promise<void> {
      await db.transaction(async tx => {
        await tx.insert(auditLogs).values(audit)
        if (timelineMessage) await tx.insert(messages).values(timelineMessage)
      })
    },

    async resolve(input): Promise<AuditLog | null> {
      const [updated] = await db
        .update(auditLogs)
        .set({
          status: input.status,
          operator: input.operator,
          automatic: input.automatic,
        })
        .where(
          and(
            eq(auditLogs.conversationId, input.conversationId),
            eq(auditLogs.approvalId, input.approvalId),
            eq(auditLogs.status, 'pending'),
          ),
        )
        .returning()
      if (updated) return updated
      const [existing] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.conversationId, input.conversationId), eq(auditLogs.approvalId, input.approvalId)))
        .limit(1)
      return existing ?? null
    },

    findByIds(ids): Promise<AuditLog[]> {
      if (ids.length === 0) return Promise.resolve([])
      return db
        .select()
        .from(auditLogs)
        .where(inArray(auditLogs.id, [...ids]))
    },

    listByConversation(id: ConversationId): Promise<AuditLog[]> {
      return db.select().from(auditLogs).where(eq(auditLogs.conversationId, id)).orderBy(asc(auditLogs.createdAt))
    },
  }
}
