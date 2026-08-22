import { describe, expect, test } from 'bun:test'
import { hydrateTimeline } from './timeline'
import type { AuditLog, Message } from '../repository'

function message(input: Partial<Message> & Pick<Message, 'id' | 'createdAt' | 'role'>): Message {
  return {
    conversationId: 'conversation-1',
    content: '',
    attachments: [],
    contextEligible: true,
    messageType: 'chat',
    auditLogId: null,
    ...input,
  } as Message
}

function audit(input: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'audit-1',
    conversationId: 'conversation-1',
    approvalId: 'approval-1',
    request: { command: 'Bash', detail: { command: 'pwd' } },
    status: 'pending',
    operator: null,
    automatic: false,
    createdAt: 2,
    ...input,
  } as AuditLog
}

describe('hydrateTimeline', () => {
  test('按时间和 ID 稳定排序，并将聊天与审批合并为一条时间线', () => {
    const items = hydrateTimeline(
      [
        message({ id: 'message-b', createdAt: 2, role: 'assistant', content: 'answer' }),
        message({
          id: 'approval-message',
          createdAt: 2,
          role: 'assistant',
          messageType: 'approval',
          auditLogId: 'audit-1',
        }),
        message({ id: 'message-a', createdAt: 1, role: 'user', content: 'question' }),
      ],
      [audit()],
    )

    expect(items.map(item => item.id)).toEqual(['message-a', 'approval-message', 'message-b'])
    expect(items[1]).toMatchObject({ type: 'approval', approval: { approvalId: 'approval-1', status: 'pending' } })
  })

  test('审批引用缺失时保留时间线位置并返回 null 详情', () => {
    const [item] = hydrateTimeline(
      [
        message({
          id: 'approval-message',
          createdAt: 1,
          role: 'assistant',
          messageType: 'approval',
          auditLogId: 'missing',
        }),
      ],
      [],
    )

    expect(item).toEqual({ type: 'approval', id: 'approval-message', createdAt: 1, approval: null })
  })

  test('系统消息不进入管理员聊天时间线', () => {
    expect(hydrateTimeline([message({ id: 'system', createdAt: 1, role: 'system' })], [])).toEqual([])
  })
})
