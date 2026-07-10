/**
 * 全局基础类型（叶子模块，不依赖任何业务模块）。
 * 契约细节见 docs/03-Interface-Contracts.md §0。
 */

export type Platform = 'telegram' | 'qq' | 'websocket'
export type CliType = 'claude' | 'opencode' | 'codex' | 'gemini'
export type UserLanguage = 'zh' | 'en'

/** 会话状态（对应 docs/02-Architecture.md §5.2 状态机）。 */
export type SessionStatus =
  | 'idle' // 无活跃进程，可唤醒
  | 'starting' // 正在拉起 Runtime
  | 'running' // 交互中
  | 'closing' // 归档中
  | 'closed' // 已归档

export type Role = 'user' | 'assistant' | 'system'
export type MemoryType = 'episodic' | 'semantic' | 'preference'
export type ApprovalAction = 'approve' | 'reject'

/** 当前个人 AI Hub 实例默认共享记忆池。 */
export const DEFAULT_MEMORY_NAMESPACE = 'global'

/** 分支品牌类型，防止不同 ID 串用。 */
export type ConversationId = string & { readonly __brand: 'ConversationId' }
export type MessageId = string & { readonly __brand: 'MessageId' }

export type Unsubscribe = () => void

/** Transport 侧消息句柄：抽象各平台 message_id 差异，供 editMessage 定位。 */
export interface MessageRef {
  platform: Platform
  chatId: string
  nativeId: string
}
