/**
 * ConversationRepository —— Drizzle 实现（docs/03 §5 / docs/04 §3）。
 * 唯一允许出现 SQL/Drizzle 查询的层。
 */
import { and, count, desc, eq, inArray, lt, ne, or } from 'drizzle-orm'
import type { Db } from '../storage'
import { auditLogs, conversationFiles, conversations, messages } from '../storage/schema'
import type {
  ConversationAdminPage,
  ConversationAdminSummary,
  ConversationDeletionAggregate,
  ConversationRepository,
  Conversation,
  NewConversation,
  ConversationId,
  Platform,
  SessionStatus,
} from './types'

export function createConversationRepository(db: Db): ConversationRepository {
  return {
    async create(c: NewConversation): Promise<Conversation> {
      const [row] = await db.insert(conversations).values(c).returning()
      if (!row) throw new Error('ConversationRepository.create: 插入未返回行')
      return row
    },

    async findLatestOpen(platform, userId, cli): Promise<Conversation | null> {
      const [row] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.platform, platform),
            eq(conversations.userId, userId),
            eq(conversations.cli, cli),
            ne(conversations.status, 'closed'),
            ne(conversations.status, 'closing'),
          ),
        )
        .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
        .limit(1)
      return row ?? null
    },

    async findById(id: ConversationId): Promise<Conversation | null> {
      const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1)
      return row ?? null
    },

    listRecentByUser(platform: Platform, userId: string, limit: number): Promise<Conversation[]> {
      return db
        .select()
        .from(conversations)
        .where(and(eq(conversations.platform, platform), eq(conversations.userId, userId)))
        .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
        .limit(limit)
    },

    async updateStatus(id: ConversationId, status: SessionStatus): Promise<void> {
      // 状态变更即应用写入，同步 updatedAt —— 支撑归档扫描「idle 起始时间」语义。
      await db.update(conversations).set({ status, updatedAt: Date.now() }).where(eq(conversations.id, id))
    },

    async resetOpenCwds(platform, userId, defaults): Promise<void> {
      await db.transaction(async tx => {
        for (const value of defaults) {
          await tx
            .update(conversations)
            .set({ cwd: value.cwd, updatedAt: Date.now() })
            .where(
              and(
                eq(conversations.platform, platform),
                eq(conversations.userId, userId),
                eq(conversations.cli, value.cli),
                ne(conversations.status, 'closed'),
                ne(conversations.status, 'closing'),
              ),
            )
        }
      })
    },

    async reconcileRuntimeStatuses(now: number): Promise<void> {
      await db
        .update(conversations)
        .set({ status: 'idle', updatedAt: now })
        .where(inArray(conversations.status, ['starting', 'running']))
      await db
        .update(conversations)
        .set({ status: 'closed', updatedAt: now })
        .where(eq(conversations.status, 'closing'))
    },

    listStaleIdle(beforeTs: number): Promise<Conversation[]> {
      return db
        .select()
        .from(conversations)
        .where(and(eq(conversations.status, 'idle'), lt(conversations.updatedAt, beforeTs)))
    },

    async listAdminPage(query): Promise<ConversationAdminPage> {
      const conditions = []
      if (query.platform) conditions.push(eq(conversations.platform, query.platform))
      if (query.userId) conditions.push(eq(conversations.userId, query.userId))
      if (query.cli) conditions.push(eq(conversations.cli, query.cli))
      if (query.status) conditions.push(eq(conversations.status, query.status))
      if (query.before) {
        conditions.push(
          or(
            lt(conversations.updatedAt, query.before.timestamp),
            and(eq(conversations.updatedAt, query.before.timestamp), lt(conversations.id, query.before.id)),
          ),
        )
      }
      const rows = await db
        .select()
        .from(conversations)
        .where(and(...conditions))
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(query.limit + 1)
      const hasMore = rows.length > query.limit
      const pageRows = hasMore ? rows.slice(0, query.limit) : rows
      const ids = pageRows.map(row => row.id)
      if (!ids.length) return { items: [], nextCursor: null }

      const [messageCounts, fileCounts, auditCounts] = await Promise.all([
        db
          .select({ conversationId: messages.conversationId, count: count() })
          .from(messages)
          .where(inArray(messages.conversationId, ids))
          .groupBy(messages.conversationId),
        db
          .select({ conversationId: conversationFiles.conversationId, count: count() })
          .from(conversationFiles)
          .where(inArray(conversationFiles.conversationId, ids))
          .groupBy(conversationFiles.conversationId),
        db
          .select({ conversationId: auditLogs.conversationId, count: count() })
          .from(auditLogs)
          .where(inArray(auditLogs.conversationId, ids))
          .groupBy(auditLogs.conversationId),
      ])
      const counts = (rows: Array<{ conversationId: string; count: number }>) =>
        new Map(rows.map(row => [row.conversationId, Number(row.count)]))
      const messageByConversation = counts(messageCounts)
      const fileByConversation = counts(fileCounts)
      const auditByConversation = counts(auditCounts)
      const items: ConversationAdminSummary[] = pageRows.map(row => ({
        ...row,
        messageCount: messageByConversation.get(row.id) ?? 0,
        fileCount: fileByConversation.get(row.id) ?? 0,
        auditCount: auditByConversation.get(row.id) ?? 0,
      }))
      const last = pageRows.at(-1)
      return {
        items,
        nextCursor: hasMore && last ? { timestamp: last.updatedAt, id: last.id } : null,
      }
    },

    async deleteAggregate(id: ConversationId): Promise<ConversationDeletionAggregate | null> {
      return db.transaction(async tx => {
        const [existing] = await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id))
        if (!existing) return null
        const [fileRows, messageCount, auditCount, fileCount] = await Promise.all([
          tx
            .select({ localPath: conversationFiles.localPath })
            .from(conversationFiles)
            .where(eq(conversationFiles.conversationId, id)),
          tx.select({ count: count() }).from(messages).where(eq(messages.conversationId, id)),
          tx.select({ count: count() }).from(auditLogs).where(eq(auditLogs.conversationId, id)),
          tx.select({ count: count() }).from(conversationFiles).where(eq(conversationFiles.conversationId, id)),
        ])
        const [deleted] = await tx
          .delete(conversations)
          .where(eq(conversations.id, id))
          .returning({ id: conversations.id })
        if (!deleted) return null
        return {
          conversationId: id,
          managedFilePaths: fileRows.map(row => row.localPath),
          deleted: {
            messages: Number(messageCount[0]?.count ?? 0),
            audits: Number(auditCount[0]?.count ?? 0),
            files: Number(fileCount[0]?.count ?? 0),
          },
        }
      })
    },
  }
}
