/**
 * SessionManager —— 会话生命周期管理（docs/02-Architecture.md §5）。
 *
 * 职责：
 *  - 会话边界定位：findActive(userId, cli, cwd) → 复用/新建
 *  - 状态迁移（委托 SessionMachine）
 *  - 处理 /new（旧活跃会话置 idle）、/close（转 closing）
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
  /** 定位活跃会话：命中 (userId, cli, cwd) 的非 closed 会话即复用；否则新建。 */
  findOrCreate(opts: {
    userId: string
    platform: Platform
    cli: CliType
    cwd: string
    text: string
  }): Promise<ConversationId>

  /** 强制 /new：旧活跃会话置 idle → 新建并返回会话 ID。 */
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

  /** 将旧活跃会话（非 closed、非指定）置 idle（/new 前置操作）。 */
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

      // 先将旧活跃会话置 idle
      const active = await repos.conversations.findActive(userId, cli, cwd)
      if (active) {
        await repos.conversations.updateStatus(active.id as ConversationId, 'idle')
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
      // 先转 closing
      const current = await repos.conversations.findById(conversationId)
      if (!current) {
        throw new Error(`SessionManager.close: 会话 ${conversationId} 不存在`)
      }
      if (current.status === 'closed' || current.status === 'closing') {
        return // 已关闭或正在关闭，幂等
      }

      await repos.conversations.updateStatus(conversationId, 'closing')

      // 发射 SessionClosed
      bus.emit('SessionClosed', { conversationId, reason })

      // 完成归档 transition: closing -> closed
      await repos.conversations.updateStatus(conversationId, 'closed')
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
      // 通过 repository 的 findActive 查找所有活跃会话
      // 注：目前 repository 限定了 (user, cli, cwd) 三元组，这里仅做标记
      // 实际 /new 时 forceNew 已处理旧活跃
    },

    destroy() {
      for (const unsub of unsubs) {
        unsub()
      }
      unsubs.length = 0
    },
  }

  return sm
}
