/**
 * Event Bus 类型契约 —— 模块间唯一通信枢纽的 payload 定义。
 * 契约见 docs/03-Interface-Contracts.md §1；新增事件只在此扩展 EventMap 一处。
 */
import type { CliType, ConversationId, MemoryType, MessageRef, Platform, Unsubscribe } from '../shared'

export interface EventMap {
  // —— 会话生命周期 ——
  SessionCreated: {
    conversationId: ConversationId
    platform: Platform
    userId: string
    cli: CliType
    cwd: string
  }
  SessionClosed: { conversationId: ConversationId; reason: 'user' | 'archiveTimeout' }

  // —— 消息 ——
  /**
   * 用户消息入站（决策 D13）：Transport 发出时**不含 conversationId**——会话边界是
   * (userId, cli, cwd)，由 Core 的 MessageRouter 经 sessionManager.findOrCreate 解析/新建。
   * 与架构 §4.1「Core 收到 MessageReceived 后才路由到会话」一致。
   */
  MessageReceived: {
    userId: string
    platform: Platform
    cli: CliType
    cwd: string
    text: string
    ref: MessageRef
  }
  /** final=false 为流式增量。 */
  MessageGenerated: { conversationId: ConversationId; content: string; final: boolean }

  // —— 审批（Human-in-the-loop）——
  ApprovalRequested: {
    conversationId: ConversationId
    approvalId: string
    command: string
    detail: string
  }
  ApprovalApproved: { conversationId: ConversationId; approvalId: string; operator: string }
  ApprovalRejected: { conversationId: ConversationId; approvalId: string; operator: string }

  // —— 进程 ——
  PTYStarted: { conversationId: ConversationId; pid: number }
  PTYExited: {
    conversationId: ConversationId
    code: number | null
    reason: 'idleTimeout' | 'crash' | 'stop'
  }

  // —— 记忆 ——
  MemoryUpdated: {
    conversationId: ConversationId | null
    userId: string
    memoryType: MemoryType
    memoryId: string
  }

  // —— 错误 ——
  ErrorOccurred: {
    scope: string
    message: string
    cause?: unknown
    conversationId?: ConversationId
  }
}

export type EventType = keyof EventMap

/** 类型安全的事件总线。payload 由 EventMap 钉死。 */
export interface EventBus {
  emit<E extends EventType>(type: E, payload: EventMap[E]): void
  on<E extends EventType>(type: E, handler: (p: EventMap[E]) => void): Unsubscribe
  once<E extends EventType>(type: E, handler: (p: EventMap[E]) => void): Unsubscribe
}

/**
 * 全部事件名的运行期清单（logger 等需遍历订阅）。
 * 用 Record<EventType, true> 强制与 EventMap 完全同步：漏写/多写任一键都会编译报错。
 */
const EVENT_TYPE_REGISTRY: Record<EventType, true> = {
  SessionCreated: true,
  SessionClosed: true,
  MessageReceived: true,
  MessageGenerated: true,
  ApprovalRequested: true,
  ApprovalApproved: true,
  ApprovalRejected: true,
  PTYStarted: true,
  PTYExited: true,
  MemoryUpdated: true,
  ErrorOccurred: true,
}

export const ALL_EVENT_TYPES = Object.keys(EVENT_TYPE_REGISTRY) as EventType[]
