/**
 * AuditRepository —— Drizzle 实现（docs/03 §5 / docs/04 §5）。
 * 永久留痕：创建、终态更新与查询，无 delete（强约束）。
 */
import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm'
import type { Db } from '../storage'
import { auditLogs, conversations, messages } from '../storage/schema'
import type { AuditAdminPage, AuditAdminRow, AuditRepository, AuditLog, ConversationId } from './types'

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

    async listAdminPage(query): Promise<AuditAdminPage> {
      const conditions = []
      if (query.conversationId) conditions.push(eq(auditLogs.conversationId, query.conversationId))
      if (query.platform) conditions.push(eq(conversations.platform, query.platform))
      if (query.userId) conditions.push(eq(conversations.userId, query.userId))
      if (query.cli) conditions.push(eq(conversations.cli, query.cli))
      if (query.status) conditions.push(eq(auditLogs.status, query.status))
      if (query.before) {
        conditions.push(
          or(
            lt(auditLogs.createdAt, query.before.timestamp),
            and(eq(auditLogs.createdAt, query.before.timestamp), lt(auditLogs.id, query.before.id)),
          ),
        )
      }
      const rows = await db
        .select({ audit: auditLogs, conversation: conversations })
        .from(auditLogs)
        .innerJoin(conversations, eq(auditLogs.conversationId, conversations.id))
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(query.limit + 1)
      const hasMore = rows.length > query.limit
      const pageRows = hasMore ? rows.slice(0, query.limit) : rows
      const items: AuditAdminRow[] = pageRows.map(row => ({
        ...row.audit,
        platform: row.conversation.platform,
        userId: row.conversation.userId,
        cli: row.conversation.cli,
        cwd: row.conversation.cwd,
      }))
      const last = items.at(-1)
      return {
        items,
        nextCursor: hasMore && last ? { timestamp: last.createdAt, id: last.id } : null,
      }
    },
  }
}
