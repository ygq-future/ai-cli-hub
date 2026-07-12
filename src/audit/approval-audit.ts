/**
 * ApprovalAudit —— 手动/自动 Approval 决议永久审计旁路。
 *
 * 只订阅审批事件并写 AuditRepository；失败转 ErrorOccurred，不阻塞主链路。
 */
import type { EventBus, EventMap } from '../event'
import type { AuditRepository } from '../repository'
import type { ConversationId, Unsubscribe } from '../shared'

export interface ApprovalAudit {
  destroy(): void
}

export interface ApprovalAuditDeps {
  bus: EventBus
  audit: AuditRepository
}

interface PendingApproval {
  command: string
  detail: string
}

export function createApprovalAudit(deps: ApprovalAuditDeps): ApprovalAudit {
  const { bus, audit } = deps
  const pending = new Map<string, PendingApproval>()
  const unsubs: Unsubscribe[] = []

  function pendingKey(conversationId: ConversationId, approvalId: string): string {
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

  async function recordDecision(
    payload: EventMap['ApprovalApproved'] | EventMap['ApprovalRejected'],
    action: 'approve' | 'reject',
  ) {
    const key = pendingKey(payload.conversationId, payload.approvalId)
    const request = pending.get(key)
    pending.delete(key)

    try {
      await audit.record({
        id: crypto.randomUUID(),
        conversationId: payload.conversationId,
        command: formatCommandForAudit(payload.approvalId, request),
        action,
        operator: payload.operator,
        createdAt: Date.now(),
      })
    } catch (err) {
      reportError('audit:recordApprovalDecision', err, payload.conversationId)
    }
  }

  unsubs.push(
    bus.on('ApprovalRequested', payload => {
      pending.set(pendingKey(payload.conversationId, payload.approvalId), {
        command: payload.command,
        detail: payload.detail,
      })
    }),
  )
  unsubs.push(
    bus.on('ApprovalApproved', payload => {
      void recordDecision(payload, 'approve')
    }),
  )
  unsubs.push(
    bus.on('ApprovalRejected', payload => {
      void recordDecision(payload, 'reject')
    }),
  )

  return {
    destroy() {
      for (const unsub of unsubs) unsub()
      unsubs.length = 0
      pending.clear()
    },
  }
}

function formatCommandForAudit(approvalId: string, request: PendingApproval | undefined): string {
  if (!request) return `approvalId=${approvalId}\nrequest=<missing>`
  const lines = [`command=${request.command}`, `approvalId=${approvalId}`]
  const detail = request.detail.trim()
  if (detail) lines.push(`detail=${detail}`)
  return lines.join('\n')
}
