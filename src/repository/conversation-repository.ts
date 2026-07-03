/**
 * ConversationRepository —— Drizzle 实现（docs/03 §5 / docs/04 §3）。
 * 唯一允许出现 SQL/Drizzle 查询的层。
 */
import { and, desc, eq, lt, ne } from 'drizzle-orm'
import type { Db } from '../storage'
import { conversations } from '../storage/schema'
import type {
  ConversationRepository,
  Conversation,
  NewConversation,
  ConversationId,
  CliType,
  SessionStatus,
} from './types'

export function createConversationRepository(db: Db): ConversationRepository {
  return {
    async create(c: NewConversation): Promise<Conversation> {
      const [row] = await db.insert(conversations).values(c).returning()
      if (!row) throw new Error('ConversationRepository.create: 插入未返回行')
      return row
    },

    async findActive(userId: string, cli: CliType, cwd: string): Promise<Conversation | null> {
      const [row] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.userId, userId),
            eq(conversations.cli, cli),
            eq(conversations.cwd, cwd),
            ne(conversations.status, 'closed'), // 非 closed 即活跃可复用
          ),
        )
        .orderBy(desc(conversations.updatedAt))
        .limit(1)
      return row ?? null
    },

    async findById(id: ConversationId): Promise<Conversation | null> {
      const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1)
      return row ?? null
    },

    async updateStatus(id: ConversationId, status: SessionStatus): Promise<void> {
      // 状态变更即应用写入，同步 updatedAt —— 支撑归档扫描「idle 起始时间」语义。
      await db.update(conversations).set({ status, updatedAt: Date.now() }).where(eq(conversations.id, id))
    },

    async listStaleIdle(beforeTs: number): Promise<Conversation[]> {
      return db
        .select()
        .from(conversations)
        .where(and(eq(conversations.status, 'idle'), lt(conversations.updatedAt, beforeTs)))
    },
  }
}
