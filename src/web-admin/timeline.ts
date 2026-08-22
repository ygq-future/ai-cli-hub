import type { AuditLog, Message } from '../repository'
import type { ApprovalView, ConversationId, TimelineItem } from '../shared'

export function hydrateTimeline(messages: readonly Message[], audits: readonly AuditLog[]): TimelineItem[] {
  const auditById = new Map(audits.map(audit => [audit.id, audit]))
  return [...messages]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .flatMap<TimelineItem>(message => {
      if (message.messageType === 'approval') {
        const audit = message.auditLogId ? auditById.get(message.auditLogId) : undefined
        return [
          {
            type: 'approval',
            id: message.id,
            createdAt: message.createdAt,
            approval: audit ? toApprovalView(audit) : null,
          },
        ]
      }
      if (message.role !== 'user' && message.role !== 'assistant') return []
      return [
        {
          type: 'chat',
          id: message.id,
          role: message.role,
          content: message.content,
          attachments: message.attachments,
          createdAt: message.createdAt,
        },
      ]
    })
}

function toApprovalView(audit: AuditLog): ApprovalView {
  return {
    id: audit.id,
    conversationId: audit.conversationId as ConversationId,
    approvalId: audit.approvalId,
    request: audit.request,
    status: audit.status,
    operator: audit.operator,
    automatic: audit.automatic,
    createdAt: audit.createdAt,
  }
}
