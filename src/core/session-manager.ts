/**
 * SessionManager —— 会话生命周期管理（docs/02-Architecture.md §5）。
 *
 * 职责：
 *  - 会话边界定位：优先复用用户最新未关闭会话，目标丢失时恢复 cli/cwd
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
  /** 定位 scope=(platform,userId) 内活跃会话：复用最新未关闭会话；没有则新建。 */
  findOrCreate(opts: {
    userId: string
    platform: Platform
    cli: CliType
    cwd: string
    text: string
  }): Promise<ConversationId>

  /** 当前可复用会话：先按 platform+userId 最新未关闭兜底，供命令查询/关闭使用。 */
  findCurrent(opts: { userId: string; platform: Platform; cli: CliType; cwd: string }): Promise<ConversationId | null>

  /** 强制 /new：关闭同边界旧活跃会话 → 新建并返回会话 ID。 */
  forceNew(opts: {
    userId: string
    platform: Platform
    cli: CliType
    cwd: string
    text: string
    cliExplicit?: boolean
    cwdExplicit?: boolean
  }): Promise<ConversationId>

  /** 关闭会话（/close 或归档触发）。 */
  close(conversationId: ConversationId, reason: 'user' | 'archiveTimeout'): Promise<void>

  /** 状态迁移，更新 DB + 发事件。 */
  transition(conversationId: ConversationId, event: SessionEvent): Promise<SessionStatus>

  /** 获取当前状态。 */
  getStatus(conversationId: ConversationId): Promise<SessionStatus | null>

  /** 归档扫描：返回所有超期 idle 会话。 */
  listStaleIdle(): Promise<{ id: ConversationId; updatedAt: number }[]>

  /** 关闭除指定会话外、同 scope 的历史未 closed 会话。 */
  setIdleExcept(conversationId: ConversationId): Promise<void>

  /** 停止监听事件。 */
  destroy(): void
}

export function createSessionManager(bus: EventBus, repos: Repositories, archiveDays: number): SessionManager {
  // 订阅事件：外部事件触发状态迁移
  const unsubs: Unsubscribe[] = []

  const sm: SessionManager = {
    async findOrCreate(opts) {
      const { userId, platform, text: _text } = opts

      const current = await resolveCurrentConversation({ userId, platform, cli: opts.cli, cwd: opts.cwd })
      if (current) {
        await closeOpenConversations(platform, userId, current.id as ConversationId)
        return current.id as ConversationId
      }

      await closeOpenConversations(platform, userId)
      const { cli, cwd } = await resolvePersistentTarget({
        userId,
        platform,
        cli: opts.cli,
        cwd: opts.cwd,
        preserveCli: true,
        preserveCwd: false,
      })

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

    async findCurrent(opts) {
      const current = await resolveCurrentConversation(opts)
      return current ? (current.id as ConversationId) : null
    },

    async forceNew(opts) {
      const { userId, platform, text: _text } = opts

      // /new 语义：历史未关闭会话全部关闭，新会话 idle，下一条普通消息懒启动 CLI。
      await closeOpenConversations(platform, userId)
      const { cli, cwd } = await resolvePersistentTarget({
        userId,
        platform,
        cli: opts.cli,
        cwd: opts.cwd,
        preserveCli: !opts.cliExplicit,
        preserveCwd: false,
      })

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

    async setIdleExcept(conversationId) {
      const conv = await repos.conversations.findById(conversationId)
      if (!conv) return
      await closeOpenConversations(conv.platform, conv.userId, conversationId)
    },

    destroy() {
      for (const unsub of unsubs) {
        unsub()
      }
      unsubs.length = 0
    },
  }

  return sm

  async function resolveCurrentConversation(opts: { userId: string; platform: Platform; cli: CliType; cwd: string }) {
    const latest = await repos.conversations.findLatestOpenByUser(opts.platform, opts.userId)
    if (!latest) return null
    const conversationId = latest.id as ConversationId
    bus.emit('SessionMapped', {
      conversationId,
      platform: opts.platform,
      userId: opts.userId,
    })
    if (latest.cli !== opts.cli || latest.cwd !== opts.cwd) {
      bus.emit('UserTargetChanged', {
        userId: opts.userId,
        platform: opts.platform,
        cli: latest.cli as CliType,
        cwd: latest.cwd,
      })
    }
    return latest
  }

  async function resolvePersistentTarget(opts: {
    userId: string
    platform: Platform
    cli: CliType
    cwd: string
    preserveCli: boolean
    preserveCwd: boolean
  }): Promise<{ cli: CliType; cwd: string }> {
    const latest = await repos.conversations.findLatestByUser(opts.platform, opts.userId)
    const cli = opts.preserveCli && latest ? (latest.cli as CliType) : opts.cli
    const cwd = opts.preserveCwd && latest ? latest.cwd : opts.cwd
    if (cli !== opts.cli || cwd !== opts.cwd) {
      bus.emit('UserTargetChanged', {
        userId: opts.userId,
        platform: opts.platform,
        cli,
        cwd,
      })
    }
    return { cli, cwd }
  }

  async function closeOpenConversations(platform: Platform, userId: string, exceptConversationId?: ConversationId) {
    const open = await repos.conversations.listOpenByUser(platform, userId)
    for (const conv of open) {
      const conversationId = conv.id as ConversationId
      if (exceptConversationId && conversationId === exceptConversationId) continue
      await closeConversation(conversationId, 'user')
    }
  }

  async function closeConversation(conversationId: ConversationId, reason: 'user' | 'archiveTimeout') {
    const current = await repos.conversations.findById(conversationId)
    if (!current) {
      throw new Error(`SessionManager.close: 会话 ${conversationId} 不存在`)
    }
    if (current.status === 'closed') {
      return // 已关闭或正在关闭，幂等
    }
    if (current.status === 'closing') {
      await repos.conversations.updateStatus(conversationId, 'closed')
      return
    }

    await repos.conversations.updateStatus(conversationId, 'closing')
    bus.emit('SessionClosed', { conversationId, reason })
    await repos.conversations.updateStatus(conversationId, 'closed')
  }
}
