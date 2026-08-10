/**
 * ApprovalAudit —— 审批请求与手动/自动决议的永久结构化审计旁路。
 *
 * 只订阅审批事件并写 Repository；失败转 ErrorOccurred，不阻塞 Tool Approval 主链路。
 */
import type { EventBus, EventMap } from '../event'
import type { AuditRepository, ConversationRepository } from '../repository'
import type { ConversationId, JsonValue, Unsubscribe } from '../shared'

export interface ApprovalAudit {
  destroy(): void
}

export interface ApprovalAuditDeps {
  bus: EventBus
  audit: AuditRepository
  conversations: Pick<ConversationRepository, 'findById'>
}

export function createApprovalAudit(deps: ApprovalAuditDeps): ApprovalAudit {
  const { bus, audit, conversations } = deps
  const creations = new Map<string, Promise<void>>()
  const unsubs: Unsubscribe[] = []

  function approvalKey(conversationId: ConversationId, approvalId: string): string {
    return `${conversationId}:${approvalId}`
  }

  function reportError(scope: string, err: unknown, conversationId: ConversationId) {
    bus.emit('ErrorOccurred', {
      scope,
      message: err instanceof Error ? err.message : String(err),
      cause: err,
      conversationId,
    })
  }

  async function createPending(payload: EventMap['ApprovalRequested']): Promise<void> {
    const conversation = await conversations.findById(payload.conversationId)
    if (!conversation) throw new Error(`审批所属会话不存在：${payload.conversationId}`)
    const auditId = crypto.randomUUID()
    await audit.createPending(
      {
        id: auditId,
        conversationId: payload.conversationId,
        approvalId: payload.approvalId,
        request: { command: payload.command, detail: parseDetail(payload.detail) },
        status: 'pending',
        operator: null,
        automatic: false,
        createdAt: payload.createdAt,
      },
      conversation.platform === 'web'
        ? {
            id: crypto.randomUUID(),
            conversationId: payload.conversationId,
            role: 'assistant',
            content: '',
            attachments: [],
            contextEligible: false,
            messageType: 'approval',
            auditLogId: auditId,
            createdAt: payload.createdAt,
          }
        : undefined,
    )
  }

  async function resolveApproval(
    payload: EventMap['ApprovalApproved'] | EventMap['ApprovalRejected'],
    status: 'approved' | 'rejected',
  ): Promise<void> {
    const key = approvalKey(payload.conversationId, payload.approvalId)
    const creation = creations.get(key)
    if (creation) {
      try {
        await creation
      } catch {
        creations.delete(key)
        return
      }
    }
    creations.delete(key)
    try {
      const resolved = await audit.resolve({
        conversationId: payload.conversationId,
        approvalId: payload.approvalId,
        status,
        operator: payload.operator,
        automatic: status === 'approved' && 'automatic' in payload && payload.automatic === true,
      })
      if (!resolved) throw new Error(`找不到待决议审批：${payload.approvalId}`)
    } catch (err) {
      reportError('audit:resolveApproval', err, payload.conversationId)
    }
  }

  unsubs.push(
    bus.on('ApprovalRequested', payload => {
      const key = approvalKey(payload.conversationId, payload.approvalId)
      const creation = createPending(payload)
      creations.set(key, creation)
      void creation.catch(err => reportError('audit:createPendingApproval', err, payload.conversationId))
      void creation.then(
        () => {
          if (creations.get(key) === creation) creations.delete(key)
        },
        () => {
          if (creations.get(key) === creation) creations.delete(key)
        },
      )
    }),
  )
  unsubs.push(
    bus.on('ApprovalApproved', payload => {
      void resolveApproval(payload, 'approved')
    }),
  )
  unsubs.push(
    bus.on('ApprovalRejected', payload => {
      void resolveApproval(payload, 'rejected')
    }),
  )

  return {
    destroy() {
      for (const unsub of unsubs) unsub()
      unsubs.length = 0
      creations.clear()
    },
  }
}

function parseDetail(detail: string): JsonValue {
  try {
    return JSON.parse(detail) as JsonValue
  } catch {
    return detail
  }
}
