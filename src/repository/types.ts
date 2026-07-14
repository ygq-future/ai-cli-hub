/**
 * Repository 契约 —— 唯一 SQL 出口的抽象面（docs/03-Interface-Contracts.md §5）。
 * Core 与业务模块只依赖本文件的接口与实体类型，不碰 Drizzle。
 *
 * 实体类型（Conversation/Message/...）源自 storage/ 的 $inferSelect/$inferInsert（docs/04），
 * 在此再导出，令 core/ 经 repository/ 获取领域类型而无需直连 storage/（遵依赖矩阵）。
 */
import type { CliType, Platform, SessionStatus, ConversationId, MessageId } from '../shared'
import type {
  Conversation,
  NewConversation,
  Message,
  NewMessage,
  AuditLog,
  NewAuditLog,
  Memory,
  NewMemory,
  UserPreference,
  UserCliPreference,
} from '../storage'

export type {
  Conversation,
  NewConversation,
  Message,
  NewMessage,
  AuditLog,
  NewAuditLog,
  Memory,
  NewMemory,
  UserPreference,
  UserCliPreference,
}
export type { CliType, Platform, SessionStatus, ConversationId, MessageId }

export interface ConversationRepository {
  create(c: NewConversation): Promise<Conversation>
  /** scope=(platform,userId,cli) 内最新可复用会话。 */
  findLatestOpen(platform: Platform, userId: string, cli: CliType): Promise<Conversation | null>
  findById(id: ConversationId): Promise<Conversation | null>
  listRecentByUser(platform: Platform, userId: string, limit: number): Promise<Conversation[]>
  updateStatus(id: ConversationId, status: SessionStatus): Promise<void>
  /** 进程重启对账：starting/running 复位 idle，closing 收尾 closed；运行期 adapter 无法恢复。 */
  reconcileRuntimeStatuses(now: number): Promise<void>
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
  /** M8：环境快照等稳定 tag 记忆幂等写入；同 namespace+tag 存在则更新 content/type/importance。 */
  upsertByTag(
    namespace: string,
    tag: string,
    m: Omit<NewMemory, 'id' | 'namespace' | 'tag' | 'createdAt'>,
  ): Promise<Memory>
  /** 实例级全局记忆：conversationId 为 NULL，启动时全量注入，不受 MEMORY_RECALL_TOP_K 限制。 */
  listGlobal(namespace: string): Promise<Memory[]>
  findById(id: string): Promise<Memory | null>
  /** V1：关系 + FTS 关键词召回 Top-K；用于后续跨会话召回补充。 */
  searchByKeyword(namespace: string, query: string, topK: number): Promise<Memory[]>
  /** V1.5：向量近邻检索（embedding 非空时启用）。V1 留桩。 */
  searchByVector(namespace: string, embedding: number[], topK: number): Promise<Memory[]>
  /** V1.5：异步回填或更新单条记忆向量。 */
  setEmbedding(id: string, embedding: number[]): Promise<void>
  /** 命中记忆时更新 accessCount / lastAccessedAt。 */
  touch(id: string): Promise<void>
  delete(id: string): Promise<void>
}

export interface UserPreferenceRepository {
  getOrCreate(input: {
    platform: Platform
    userId: string
    language: 'zh' | 'en'
    defaultCli: CliType
  }): Promise<UserPreference>
  setLanguage(platform: Platform, userId: string, language: 'zh' | 'en'): Promise<void>
  setDefaultCli(platform: Platform, userId: string, cli: CliType): Promise<void>
  setAutoApprove(platform: Platform, userId: string, enabled: boolean, seconds: number): Promise<void>
  findCliPreference(platform: Platform, userId: string, cli: CliType): Promise<UserCliPreference | null>
  upsertCwd(platform: Platform, userId: string, cli: CliType, cwd: string): Promise<void>
  setModel(platform: Platform, userId: string, cli: CliType, modelId: string, modelName: string): Promise<void>
}

/** 装配根注入 Core/业务模块的仓储集合（docs/03 §7）。 */
export interface Repositories {
  conversations: ConversationRepository
  messages: MessageRepository
  audit: AuditRepository
  memories: MemoryRepository
  userPreferences: UserPreferenceRepository
}
