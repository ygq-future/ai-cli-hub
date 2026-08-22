import { describe, expect, test } from 'bun:test'
import { createEventBus } from '../event'
import type {
  AuditLog,
  AuditRepository,
  Conversation,
  ConversationRepository,
  NewAuditLog,
  NewMessage,
} from '../repository'
import type { ConversationId } from '../shared'
import { createApprovalAudit } from './approval-audit'

const WEB_CID = 'conv-web-audit' as ConversationId
const TG_CID = 'conv-tg-audit' as ConversationId
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function conversation(id: ConversationId): Conversation {
  return {
    id,
    platform: id === WEB_CID ? 'web' : 'telegram',
    userId: 'u1',
    cli: 'claude',
    cwd: '/workspace',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  }
}

function createFakeConversationRepository(): Pick<ConversationRepository, 'findById'> {
  return { findById: async id => conversation(id) }
}

function createFakeAuditRepository(opts?: { failCreate?: boolean; createGate?: Promise<void> }) {
  const records = new Map<string, AuditLog>()
  const timelineMessages: NewMessage[] = []
  const repo: AuditRepository = {
    async createPending(record: NewAuditLog, timelineMessage?: NewMessage): Promise<void> {
      await opts?.createGate
      if (opts?.failCreate) throw new Error('audit db down')
      records.set(record.approvalId, record as AuditLog)
      if (timelineMessage) timelineMessages.push(timelineMessage)
    },
    async resolve(input): Promise<AuditLog | null> {
      const current = records.get(input.approvalId)
      if (!current) return null
      if (current.status !== 'pending') return current
      const resolved = { ...current, ...input }
      records.set(input.approvalId, resolved)
      return resolved
    },
    async findByIds(ids): Promise<AuditLog[]> {
      return [...records.values()].filter(record => ids.includes(record.id))
    },
    async listByConversation(id): Promise<AuditLog[]> {
      return [...records.values()].filter(record => record.conversationId === id)
    },
    async listAdminPage() {
      return { items: [], nextCursor: null }
    },
  }
  return { records, timelineMessages, repo }
}

describe('ApprovalAudit', () => {
  test('creates structured pending records and only Web gets a timeline message', async () => {
    const bus = createEventBus()
    const audit = createFakeAuditRepository()
    const module = createApprovalAudit({ bus, audit: audit.repo, conversations: createFakeConversationRepository() })

    bus.emit('ApprovalRequested', {
      conversationId: WEB_CID,
      approvalId: 'a1',
      command: 'Bash',
      detail: '{"cmd":"rm x"}',
      createdAt: 100,
    })
    bus.emit('ApprovalRequested', {
      conversationId: TG_CID,
      approvalId: 'a2',
      command: 'Write',
      detail: 'not-json',
      createdAt: 200,
    })
    await tick()

    expect(audit.records.get('a1')).toMatchObject({
      approvalId: 'a1',
      request: { command: 'Bash', detail: { cmd: 'rm x' } },
      status: 'pending',
      operator: null,
      automatic: false,
      createdAt: 100,
    })
    expect(audit.records.get('a2')?.request).toEqual({ command: 'Write', detail: 'not-json' })
    expect(audit.timelineMessages).toHaveLength(1)
    expect(audit.timelineMessages[0]).toMatchObject({
      conversationId: WEB_CID,
      role: 'assistant',
      content: '',
      attachments: [],
      contextEligible: false,
      messageType: 'approval',
      createdAt: 100,
    })
    expect(audit.timelineMessages[0]?.auditLogId).toBe(audit.records.get('a1')?.id)

    module.destroy()
  })

  test('records manual and automatic terminal states', async () => {
    const bus = createEventBus()
    const audit = createFakeAuditRepository()
    const module = createApprovalAudit({ bus, audit: audit.repo, conversations: createFakeConversationRepository() })

    bus.emit('ApprovalRequested', {
      conversationId: WEB_CID,
      approvalId: 'manual',
      command: 'Write',
      detail: '{}',
      createdAt: 1,
    })
    bus.emit('ApprovalRequested', {
      conversationId: WEB_CID,
      approvalId: 'auto',
      command: 'Bash',
      detail: '{}',
      createdAt: 2,
    })
    bus.emit('ApprovalRejected', { conversationId: WEB_CID, approvalId: 'manual', operator: 'u1' })
    bus.emit('ApprovalApproved', {
      conversationId: WEB_CID,
      approvalId: 'auto',
      operator: 'auto:u1',
      automatic: true,
    })
    await tick()
    await tick()

    expect(audit.records.get('manual')).toMatchObject({ status: 'rejected', operator: 'u1', automatic: false })
    expect(audit.records.get('auto')).toMatchObject({ status: 'approved', operator: 'auto:u1', automatic: true })

    module.destroy()
  })

  test('fast decision waits until pending creation finishes', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const bus = createEventBus()
    const audit = createFakeAuditRepository({ createGate: gate })
    const module = createApprovalAudit({ bus, audit: audit.repo, conversations: createFakeConversationRepository() })

    bus.emit('ApprovalRequested', {
      conversationId: WEB_CID,
      approvalId: 'fast',
      command: 'Bash',
      detail: '{}',
      createdAt: 1,
    })
    bus.emit('ApprovalApproved', { conversationId: WEB_CID, approvalId: 'fast', operator: 'u1' })
    await tick()
    expect(audit.records.has('fast')).toBe(false)
    release()
    await tick()
    await tick()
    expect(audit.records.get('fast')?.status).toBe('approved')

    module.destroy()
  })

  test('missing request and persistence failures emit ErrorOccurred without throwing', async () => {
    const bus = createEventBus()
    const audit = createFakeAuditRepository({ failCreate: true })
    const module = createApprovalAudit({ bus, audit: audit.repo, conversations: createFakeConversationRepository() })
    const errors: Array<{ scope: string; conversationId?: ConversationId }> = []
    bus.on('ErrorOccurred', payload => errors.push(payload))

    bus.emit('ApprovalRequested', {
      conversationId: WEB_CID,
      approvalId: 'broken',
      command: 'Bash',
      detail: '{}',
      createdAt: 1,
    })
    bus.emit('ApprovalApproved', { conversationId: WEB_CID, approvalId: 'missing', operator: 'u1' })
    await tick()
    await tick()

    expect(errors.map(error => error.scope)).toEqual(
      expect.arrayContaining(['audit:createPendingApproval', 'audit:resolveApproval']),
    )
    expect(audit.records).toHaveLength(0)

    module.destroy()
  })
})
