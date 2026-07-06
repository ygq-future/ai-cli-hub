/**
 * SessionManager —— 会话生命周期管理（docs/02-Architecture.md §5）。
 *
 * 职责：
 *  - 会话边界定位：findActive(userId, cli, cwd) → 复用最新可用会话/新建
 *  - 状态迁移（委托 SessionMachine）
 *  - 处理 /new（旧活跃会话关闭）、/close（转 closing）
 *  - 归档扫描 listStaleIdle
 *  - 发射 SessionCreated / SessionClosed 事件
 *
 * 不依赖任何具体 Transport/Adapter/Runtime。
 */
import type { CliType, ConversationId, Platform, SessionStatus, Unsubscribe } from '../shared'
import type { EventBus } from '../event'
import type { Repositories } from '../repository'
import { transition, type SessionEvent } from './session-machine'

export interface SessionManager {
  /** 定位活跃会话：最新同边界会话可用则复用；若最新已 closed/closing 则新建。 */
  findOrCreate(opts: {
    userId: string
    platform: Platform
    cli: CliType
    cwd: string
    text: string
  }): Promise<ConversationId>

  /** 强制 /new：关闭同边界旧活跃会话 → 新建并返回会话 ID。 */
  forceNew(opts: {
    userId: string
    platform: Platform
    cli: CliType
    cwd: string
    text: string
  }): Promise<ConversationId>

  /** 关闭会话（/close 或归档触发）。 */
  close(conversationId: ConversationId, reason: 'user' | 'archiveTimeout'): Promise<void>

  /** 状态迁移，更新 DB + 发事件。 */
  transition(conversationId: ConversationId, event: SessionEvent): Promise<SessionStatus>

  /** 获取当前状态。 */
  getStatus(conversationId: ConversationId): Promise<SessionStatus | null>

  /** 归档扫描：返回所有超期 idle 会话。 */
  listStaleIdle(): Promise<{ id: ConversationId; updatedAt: number }[]>

  /** 保留接口占位；当前 /new 直接关闭旧会话，不做 idle 批量迁移。 */
  setIdleExcept(conversationId: ConversationId): Promise<void>

  /** 停止监听事件。 */
  destroy(): void
}

export function createSessionManager(bus: EventBus, repos: Repositories, archiveDays: number): SessionManager {
  // 订阅事件：外部事件触发状态迁移
  const unsubs: Unsubscribe[] = []

  const sm: SessionManager = {
    async findOrCreate(opts) {
      const { userId, platform, cli, cwd, text: _text } = opts

      // 尝试复用现有活跃会话
      const active = await repos.conversations.findActive(userId, cli, cwd)
      if (active) {
        bus.emit('SessionMapped', {
          conversationId: active.id as ConversationId,
          platform,
          userId,
        })
        return active.id as ConversationId
      }

      // 新建
      const id = crypto.randomUUID() as ConversationId
      const now = Date.now()
      const conv = await repos.conversations.create({
        id,
        platform: platform,
        userId,
        cli,
        cwd,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })

      // 发射 SessionCreated 事件
      bus.emit('SessionCreated', {
        conversationId: conv.id as ConversationId,
        platform: platform,
        userId,
        cli,
        cwd,
      })

      return conv.id as ConversationId
    },

    async forceNew(opts) {
      const { userId, platform, cli, cwd, text: _text } = opts

      // /new 语义：旧同边界会话关闭，新会话 idle，下一条普通消息懒启动 CLI。
      const active = await repos.conversations.findActive(userId, cli, cwd)
      if (active) {
        const oldConversationId = active.id as ConversationId
        await closeConversation(oldConversationId, 'user')
      }

      // 再新建
      const id = crypto.randomUUID() as ConversationId
      const now = Date.now()
      const conv = await repos.conversations.create({
        id,
        platform,
        userId,
        cli,
        cwd,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })

      bus.emit('SessionCreated', {
        conversationId: conv.id as ConversationId,
        userId,
        platform,
        cli,
        cwd,
      })

      return conv.id as ConversationId
    },

    async close(conversationId, reason) {
      await closeConversation(conversationId, reason)
    },

    async transition(conversationId, event) {
      const conv = await repos.conversations.findById(conversationId)
      if (!conv) {
        throw new Error(`SessionManager.transition: 会话 ${conversationId} 不存在`)
      }

      const nextStatus = transition(conv.status as SessionStatus, event)
      await repos.conversations.updateStatus(conversationId, nextStatus)
      return nextStatus
    },

    async getStatus(conversationId) {
      const conv = await repos.conversations.findById(conversationId)
      return conv?.status ?? null
    },

    async listStaleIdle() {
      const beforeTs = Date.now() - archiveDays * 24 * 60 * 60 * 1000
      const stale = await repos.conversations.listStaleIdle(beforeTs)
      return stale.map(c => ({ id: c.id as ConversationId, updatedAt: c.updatedAt }))
    },

    async setIdleExcept(_conversationId) {
      // /new 已改为关闭旧会话；此接口暂不执行批量 idle 迁移。
    },

    destroy() {
      for (const unsub of unsubs) {
        unsub()
      }
      unsubs.length = 0
    },
  }

  return sm

  async function closeConversation(conversationId: ConversationId, reason: 'user' | 'archiveTimeout') {
    const current = await repos.conversations.findById(conversationId)
    if (!current) {
      throw new Error(`SessionManager.close: 会话 ${conversationId} 不存在`)
    }
    if (current.status === 'closed' || current.status === 'closing') {
      return // 已关闭或正在关闭，幂等
    }

    await repos.conversations.updateStatus(conversationId, 'closing')
    bus.emit('SessionClosed', { conversationId, reason })
    await repos.conversations.updateStatus(conversationId, 'closed')
  }
}
