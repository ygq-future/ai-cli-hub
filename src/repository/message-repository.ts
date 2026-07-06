/**
 * MessageRepository —— Drizzle 实现（docs/03 §5 / docs/04 §4）。
 */
import { asc, eq } from 'drizzle-orm'
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

    async listByConversation(id: ConversationId, limit?: number): Promise<Message[]> {
      // 按时间正序读取历史消息（idx_msg_conv 覆盖）；当前不做完整上下文回放。
      const q = db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt))
      return limit === undefined ? q : q.limit(limit)
    },
  }
}
