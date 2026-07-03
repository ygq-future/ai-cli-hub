/**
 * Repository 契约 —— 唯一 SQL 出口的抽象面（docs/03-Interface-Contracts.md §5）。
 * Core 与业务模块只依赖本文件的接口与实体类型，不碰 Drizzle。
 *
 * 实体类型（Conversation/Message/...）源自 storage/ 的 $inferSelect/$inferInsert（docs/04），
 * 在此再导出，令 core/ 经 repository/ 获取领域类型而无需直连 storage/（遵依赖矩阵）。
 */
import type { CliType, SessionStatus, ConversationId, MessageId } from '../shared/types/common'
import type {
  Conversation,
  NewConversation,
  Message,
  NewMessage,
  AuditLog,
  NewAuditLog,
  Memory,
  NewMemory,
} from '../storage'

export type { Conversation, NewConversation, Message, NewMessage, AuditLog, NewAuditLog, Memory, NewMemory }
export type { CliType, SessionStatus, ConversationId, MessageId }

export interface ConversationRepository {
  create(c: NewConversation): Promise<Conversation>
  /** 会话边界定位：命中非 closed 的活跃会话即复用（docs/04 §3）。 */
  findActive(userId: string, cli: CliType, cwd: string): Promise<Conversation | null>
  findById(id: ConversationId): Promise<Conversation | null>
  updateStatus(id: ConversationId, status: SessionStatus): Promise<void>
  /** 归档扫描：updatedAt < beforeTs 的 idle 会话。 */
  listStaleIdle(beforeTs: number): Promise<Conversation[]>
}

export interface MessageRepository {
  append(m: NewMessage): Promise<Message>
  listByConversation(id: ConversationId, limit?: number): Promise<Message[]>
}

export interface AuditRepository {
  /** 永久留痕，不提供 delete（docs/04 §5 强约束）。 */
  record(a: NewAuditLog): Promise<void>
  listByConversation(id: ConversationId): Promise<AuditLog[]>
}

export interface MemoryRepository {
  insert(m: NewMemory): Promise<Memory>
  /** V1：关系 + FTS 关键词召回 Top-K。 */
  searchByKeyword(userId: string, query: string, topK: number): Promise<Memory[]>
  /** user-level（conversationId 为 NULL）记忆取回。 */
  listUserLevel(userId: string): Promise<Memory[]>
  /** V1.5：向量近邻检索（embedding 非空时启用）。V1 留桩。 */
  searchByVector(userId: string, embedding: number[], topK: number): Promise<Memory[]>
  /** 命中记忆时更新 accessCount / lastAccessedAt。 */
  touch(id: string): Promise<void>
}

/** 装配根注入 Core/业务模块的仓储集合（docs/03 §7）。 */
export interface Repositories {
  conversations: ConversationRepository
  messages: MessageRepository
  audit: AuditRepository
  memories: MemoryRepository
}
