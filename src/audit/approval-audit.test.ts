import { describe, expect, test } from 'bun:test'
import { createEventBus } from '../event'
import type { AuditLog, NewAuditLog } from '../repository'
import type { ConversationId } from '../shared'
import { createApprovalAudit } from './approval-audit'

const CID = 'conv-audit' as ConversationId
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function createFakeAuditRepository(opts?: { fail?: boolean }) {
  const records: NewAuditLog[] = []
  return {
    records,
    repo: {
      async record(record: NewAuditLog): Promise<void> {
        if (opts?.fail) throw new Error('audit db down')
        records.push(record)
      },
      async listByConversation(id: ConversationId): Promise<AuditLog[]> {
        return records.filter(record => record.conversationId === id) as AuditLog[]
      },
    },
  }
}

describe('ApprovalAudit', () => {
  test('records approved and rejected decisions with request detail', async () => {
    const bus = createEventBus()
    const audit = createFakeAuditRepository()
    const module = createApprovalAudit({ bus, audit: audit.repo })

    bus.emit('ApprovalRequested', { conversationId: CID, approvalId: 'a1', command: 'Bash', detail: '{"cmd":"rm x"}' })
    bus.emit('ApprovalApproved', { conversationId: CID, approvalId: 'a1', operator: 'u1' })
    bus.emit('ApprovalRequested', { conversationId: CID, approvalId: 'a2', command: 'Write', detail: '{"file":"x"}' })
    bus.emit('ApprovalRejected', { conversationId: CID, approvalId: 'a2', operator: 'u2' })
    await tick()

    expect(audit.records).toHaveLength(2)
    expect(audit.records[0]!.action).toBe('approve')
    expect(audit.records[0]!.operator).toBe('u1')
    expect(audit.records[0]!.command).toContain('command=Bash')
    expect(audit.records[0]!.command).toContain('approvalId=a1')
    expect(audit.records[0]!.command).toContain('{"cmd":"rm x"}')
    expect(audit.records[1]!.action).toBe('reject')
    expect(audit.records[1]!.operator).toBe('u2')

    module.destroy()
  })

  test('records decision even when request cache is missing', async () => {
    const bus = createEventBus()
    const audit = createFakeAuditRepository()
    const module = createApprovalAudit({ bus, audit: audit.repo })

    bus.emit('ApprovalApproved', { conversationId: CID, approvalId: 'late', operator: 'u1' })
    await tick()

    expect(audit.records).toHaveLength(1)
    expect(audit.records[0]!.command).toContain('approvalId=late')
    expect(audit.records[0]!.command).toContain('request=<missing>')

    module.destroy()
  })

  test('record failure emits ErrorOccurred without throwing', async () => {
    const bus = createEventBus()
    const audit = createFakeAuditRepository({ fail: true })
    const module = createApprovalAudit({ bus, audit: audit.repo })
    const errors: Array<{ scope: string; conversationId?: ConversationId }> = []
    bus.on('ErrorOccurred', payload => errors.push(payload))

    bus.emit('ApprovalRejected', { conversationId: CID, approvalId: 'a1', operator: 'u1' })
    await tick()

    expect(errors).toHaveLength(1)
    expect(errors[0]!.scope).toBe('audit:recordApprovalDecision')
    expect(errors[0]!.conversationId).toBe(CID)

    module.destroy()
  })
})
