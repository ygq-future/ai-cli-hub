/** Session lifecycle scoped by (platform, userId, cli). */
import type { CliType, ConversationId, Platform, SessionStatus } from '../shared'
import type { EventBus } from '../event'
import type { Repositories } from '../repository'
import { transition, type SessionEvent } from './session-machine'

export interface SessionManager {
  /** Reuse or create the selected CLI session without affecting other CLIs. */
  findOrCreate(opts: {
    userId: string
    platform: Platform
    cli: CliType
    cwd: string
    text: string
  }): Promise<ConversationId>
  findCurrent(opts: { userId: string; platform: Platform; cli: CliType; cwd: string }): Promise<ConversationId | null>
  close(conversationId: ConversationId, reason: 'user' | 'archiveTimeout'): Promise<void>
  transition(conversationId: ConversationId, event: SessionEvent): Promise<SessionStatus>
  getStatus(conversationId: ConversationId): Promise<SessionStatus | null>
  listStaleIdle(): Promise<{ id: ConversationId; updatedAt: number }[]>
  destroy(): void
}

export function createSessionManager(bus: EventBus, repos: Repositories, archiveDays: number): SessionManager {
  return {
    async findOrCreate(opts) {
      const current = await resolveCurrentConversation(opts)
      if (current) return current.id as ConversationId

      const id = crypto.randomUUID() as ConversationId
      const now = Date.now()
      const conv = await repos.conversations.create({
        id,
        platform: opts.platform,
        userId: opts.userId,
        cli: opts.cli,
        cwd: opts.cwd,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })
      bus.emit('SessionCreated', {
        conversationId: conv.id as ConversationId,
        platform: opts.platform,
        userId: opts.userId,
        cli: opts.cli,
        cwd: opts.cwd,
      })
      return conv.id as ConversationId
    },

    async findCurrent(opts) {
      const current = await resolveCurrentConversation(opts)
      return current ? (current.id as ConversationId) : null
    },

    async close(conversationId, reason) {
      await closeConversation(conversationId, reason)
    },

    async transition(conversationId, event) {
      const conv = await repos.conversations.findById(conversationId)
      if (!conv) throw new Error(`SessionManager.transition: 会话 ${conversationId} 不存在`)
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

    destroy() {},
  }

  async function resolveCurrentConversation(opts: { userId: string; platform: Platform; cli: CliType; cwd: string }) {
    const latest = await repos.conversations.findLatestOpen(opts.platform, opts.userId, opts.cli)
    if (!latest) return null
    bus.emit('SessionMapped', {
      conversationId: latest.id as ConversationId,
      platform: opts.platform,
      userId: opts.userId,
    })
    return latest
  }

  async function closeConversation(conversationId: ConversationId, reason: 'user' | 'archiveTimeout') {
    const current = await repos.conversations.findById(conversationId)
    if (!current) throw new Error(`SessionManager.close: 会话 ${conversationId} 不存在`)
    if (current.status === 'closed') return
    if (current.status === 'closing') {
      await repos.conversations.updateStatus(conversationId, 'closed')
      return
    }
    await repos.conversations.updateStatus(conversationId, 'closing')
    bus.emit('SessionClosed', { conversationId, reason })
    await repos.conversations.updateStatus(conversationId, 'closed')
  }
}
