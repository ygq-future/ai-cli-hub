/**
 * MessageRepository —— Drizzle 实现（docs/03 §5 / docs/04 §4）。
 */
import { and, asc, desc, eq, lt, or } from 'drizzle-orm'
import type { Db } from '../storage'
import { messages } from '../storage/schema'
import type { MessageRepository, Message, NewMessage, ConversationId } from './types'

export function createMessageRepository(db: Db): MessageRepository {
  return {
    async append(m: NewMessage): Promise<Message> {
      const [row] = await db.insert(messages).values(m).returning()
      if (!row) throw new Error('MessageRepository.append: 插入未返回行')
      return row
    },

    async listByConversation(
      id: ConversationId,
      limit?: number,
      before?: { createdAt: number; id: string },
    ): Promise<Message[]> {
      if (limit === undefined) {
        return db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, id))
          .orderBy(asc(messages.createdAt), asc(messages.id))
      }
      const cursorCondition = before
        ? or(
            lt(messages.createdAt, before.createdAt),
            and(eq(messages.createdAt, before.createdAt), lt(messages.id, before.id)),
          )
        : undefined
      const rows = await db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, id), cursorCondition))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit)
      return rows.reverse()
    },

    async deleteByConversation(id: ConversationId): Promise<void> {
      await db.delete(messages).where(eq(messages.conversationId, id))
    },
  }
}
