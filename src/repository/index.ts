// repository —— 数据抽象接口 + Drizzle 实现（唯一 SQL 出口，Core 不碰 SQL）。
// 契约见 docs/03-Interface-Contracts.md §5。
import type { Db } from '../storage'
import { createConversationRepository } from './conversation-repository'
import { createMessageRepository } from './message-repository'
import { createAuditRepository } from './audit-repository'
import { createMemoryRepository } from './memory-repository'
import type { Repositories } from './types'

export type {
  ConversationRepository,
  MessageRepository,
  AuditRepository,
  MemoryRepository,
  Repositories,
  Conversation,
  NewConversation,
  Message,
  NewMessage,
  AuditLog,
  NewAuditLog,
  Memory,
  NewMemory,
} from './types'

/** 装配根据注入 db 组装全部仓储（docs/03 §7）。 */
export function createRepositories(db: Db): Repositories {
  return {
    conversations: createConversationRepository(db),
    messages: createMessageRepository(db),
    audit: createAuditRepository(db),
    memories: createMemoryRepository(db),
  }
}
