/**
 * AuditRepository —— Drizzle 实现（docs/03 §5 / docs/04 §5）。
 * 永久留痕：仅 record + 查询，无 delete（强约束）。
 */
import { asc, eq } from 'drizzle-orm'
import type { Db } from '../storage'
import { auditLogs } from '../storage/schema'
import type { AuditRepository, AuditLog, NewAuditLog, ConversationId } from './types'

export function createAuditRepository(db: Db): AuditRepository {
  return {
    async record(a: NewAuditLog): Promise<void> {
      await db.insert(auditLogs).values(a)
    },

    async listByConversation(id: ConversationId): Promise<AuditLog[]> {
      return db.select().from(auditLogs).where(eq(auditLogs.conversationId, id)).orderBy(asc(auditLogs.createdAt))
    },
  }
}
