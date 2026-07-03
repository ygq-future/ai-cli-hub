import { describe, expect, test } from 'bun:test'
import { createEventBus } from './bus'
import type { ConversationId } from '../shared'

const CID = 'conv-1' as ConversationId

describe('createEventBus', () => {
  test('on 收到 emit 的精确 payload', () => {
    const bus = createEventBus()
    const seen: string[] = []
    bus.on('MessageReceived', p => seen.push(p.text))
    bus.emit('MessageReceived', {
      conversationId: CID,
      userId: 'u1',
      platform: 'telegram',
      text: 'hello',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })
    expect(seen).toEqual(['hello'])
  })

  test('多个订阅者都收到；类型隔离（其它事件不触发）', () => {
    const bus = createEventBus()
    let a = 0
    let b = 0
    let other = 0
    bus.on('PTYStarted', () => a++)
    bus.on('PTYStarted', () => b++)
    bus.on('PTYExited', () => other++)
    bus.emit('PTYStarted', { conversationId: CID, pid: 42 })
    expect([a, b, other]).toEqual([1, 1, 0])
  })

  test('unsubscribe 后不再收到', () => {
    const bus = createEventBus()
    let n = 0
    const off = bus.on('PTYStarted', () => n++)
    bus.emit('PTYStarted', { conversationId: CID, pid: 1 })
    off()
    bus.emit('PTYStarted', { conversationId: CID, pid: 2 })
    expect(n).toBe(1)
  })

  test('once 只触发一次', () => {
    const bus = createEventBus()
    let n = 0
    bus.once('PTYStarted', () => n++)
    bus.emit('PTYStarted', { conversationId: CID, pid: 1 })
    bus.emit('PTYStarted', { conversationId: CID, pid: 2 })
    expect(n).toBe(1)
  })

  test('迭代期间取消订阅安全（快照）', () => {
    const bus = createEventBus()
    const order: string[] = []
    let off2: () => void = () => {}
    bus.on('PTYStarted', () => {
      order.push('h1')
      off2() // 在回调内取消尚未触发的 h2
    })
    off2 = bus.on('PTYStarted', () => order.push('h2'))
    bus.emit('PTYStarted', { conversationId: CID, pid: 1 })
    // 本轮快照已包含 h2，故仍触发一次；下一轮不再触发
    expect(order).toEqual(['h1', 'h2'])
    bus.emit('PTYStarted', { conversationId: CID, pid: 2 })
    expect(order).toEqual(['h1', 'h2', 'h1'])
  })

  test('单个订阅者抛错被隔离：其余订阅者仍执行，并转发 ErrorOccurred', () => {
    const bus = createEventBus()
    let reached = false
    const errors: string[] = []
    bus.on('ErrorOccurred', p => errors.push(p.scope))
    bus.on('PTYStarted', () => {
      throw new Error('boom')
    })
    bus.on('PTYStarted', () => {
      reached = true
    })
    bus.emit('PTYStarted', { conversationId: CID, pid: 1 })
    expect(reached).toBe(true)
    expect(errors).toEqual(['eventbus:PTYStarted'])
  })

  test('ErrorOccurred 订阅者自身抛错不回环（不无限递归）', () => {
    const bus = createEventBus()
    bus.on('ErrorOccurred', () => {
      throw new Error('handler for error also fails')
    })
    // 不应抛出 / 不应栈溢出
    expect(() => bus.emit('ErrorOccurred', { scope: 'x', message: 'y' })).not.toThrow()
  })
})
