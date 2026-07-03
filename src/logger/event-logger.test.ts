import { describe, expect, test } from 'bun:test'
import type { Logger } from 'pino'
import { attachEventLogger } from './event-logger'
import { createEventBus } from '../event'
import type { ConversationId } from '../shared'

const CID = 'conv-1' as ConversationId

/** 最小 pino Logger 桩：仅记录 child 后的 level/obj/msg 调用。 */
function makeFakeLogger() {
  const records: Array<{ level: string; obj: Record<string, unknown>; msg: unknown }> = []
  const push = (level: string) => (obj: unknown, msg: unknown) =>
    records.push({ level, obj: obj as Record<string, unknown>, msg })
  const leaf = { debug: push('debug'), info: push('info'), error: push('error') }
  const logger = { child: () => leaf } as unknown as Logger
  return { logger, records }
}

describe('attachEventLogger', () => {
  test('普通事件以 info 级别打印，携带 event 名与 payload', () => {
    const bus = createEventBus()
    const { logger, records } = makeFakeLogger()
    attachEventLogger(bus, logger)

    bus.emit('SessionCreated', {
      conversationId: CID,
      platform: 'telegram',
      userId: 'u1',
      cli: 'claude',
      cwd: '/tmp',
    })

    expect(records).toHaveLength(1)
    expect(records[0]!.level).toBe('info')
    expect(records[0]!.obj.event).toBe('SessionCreated')
    expect(records[0]!.obj.userId).toBe('u1')
    expect(records[0]!.msg).toBe('SessionCreated')
  })

  test('ErrorOccurred 走 error 级别', () => {
    const bus = createEventBus()
    const { logger, records } = makeFakeLogger()
    attachEventLogger(bus, logger)
    bus.emit('ErrorOccurred', { scope: 's', message: 'm' })
    expect(records[0]!.level).toBe('error')
  })

  test('高频 MessageGenerated 压到 debug', () => {
    const bus = createEventBus()
    const { logger, records } = makeFakeLogger()
    attachEventLogger(bus, logger)
    bus.emit('MessageGenerated', { conversationId: CID, content: 'x', final: false })
    expect(records[0]!.level).toBe('debug')
  })

  test('返回的 detach 摘除全部订阅', () => {
    const bus = createEventBus()
    const { logger, records } = makeFakeLogger()
    const detach = attachEventLogger(bus, logger)
    detach()
    bus.emit('SessionClosed', { conversationId: CID, reason: 'user' })
    expect(records).toHaveLength(0)
  })
})
