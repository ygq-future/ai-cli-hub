import { describe, expect, test } from 'bun:test'
import { createEventBus, type EventBus } from '../event'
import type { EventMap } from '../event'
import type { ConversationId } from '../shared'
import { createMessageAggregator, DEFAULT_AGGREGATOR_CONFIG } from './aggregator'

const CID = 'conv-1' as ConversationId
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 订阅 MessageGenerated，收集 (content, final)。 */
function capture(bus: EventBus) {
  const events: EventMap['MessageGenerated'][] = []
  bus.on('MessageGenerated', p => events.push(p))
  return events
}

describe('MessageAggregator', () => {
  test('默认配置对齐契约 §4', () => {
    expect(DEFAULT_AGGREGATOR_CONFIG).toEqual({ debounceMs: 400, minEditIntervalMs: 1000, maxChunkChars: 4096 })
  })

  test('空 chunk 是 no-op', async () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, { debounceMs: 10, minEditIntervalMs: 0, maxChunkChars: 100 })

    agg.push(CID, '')
    await wait(25)

    expect(events).toEqual([])
    agg.destroy()
  })

  test('debounce：静默后发一次 final=false（累计文本）', async () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, { debounceMs: 10, minEditIntervalMs: 0, maxChunkChars: 100 })

    agg.push(CID, 'hello')
    expect(events).toEqual([]) // 尚未到 debounce
    await wait(25)

    expect(events).toEqual([{ conversationId: CID, content: 'hello', final: false }])
    agg.destroy()
  })

  test('debounce 窗口内多次 push 合并为一条（累计）', async () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, { debounceMs: 15, minEditIntervalMs: 0, maxChunkChars: 100 })

    agg.push(CID, 'a')
    agg.push(CID, 'b')
    agg.push(CID, 'c')
    await wait(30)

    expect(events).toEqual([{ conversationId: CID, content: 'abc', final: false }])
    agg.destroy()
  })

  test('flush：发 final=true 全文并清空状态（再 flush 为 no-op）', async () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, { debounceMs: 100, minEditIntervalMs: 0, maxChunkChars: 100 })

    agg.push(CID, 'done')
    agg.flush(CID) // 抢在 debounce 前
    expect(events).toEqual([{ conversationId: CID, content: 'done', final: true }])

    agg.flush(CID) // 状态已删
    await wait(120) // 确认无迟到的 debounce emit
    expect(events).toHaveLength(1)
    agg.destroy()
  })

  test('流式 emit 后 flush 收尾（final=false 再 final=true）', async () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, { debounceMs: 10, minEditIntervalMs: 0, maxChunkChars: 100 })

    agg.push(CID, 'partial')
    await wait(25) // 流式 emit
    agg.flush(CID)

    expect(events).toEqual([
      { conversationId: CID, content: 'partial', final: false },
      { conversationId: CID, content: 'partial', final: true },
    ])
    agg.destroy()
  })

  test('flush 无状态：不发不抛', () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, DEFAULT_AGGREGATOR_CONFIG)

    expect(() => agg.flush(CID)).not.toThrow()
    expect(events).toEqual([])
    agg.destroy()
  })

  test('throttle：两次流式 emit 至少间隔 minEditIntervalMs（trailing 补发）', async () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, { debounceMs: 10, minEditIntervalMs: 60, maxChunkChars: 100 })

    agg.push(CID, 'a')
    await wait(25) // emit1('a')
    expect(events).toEqual([{ conversationId: CID, content: 'a', final: false }])

    agg.push(CID, 'b')
    await wait(25) // debounce 到点但仍在冷却 → 挂起，不发
    expect(events).toHaveLength(1)

    await wait(60) // 冷却结束 → 补发 emit2('ab')
    expect(events).toEqual([
      { conversationId: CID, content: 'a', final: false },
      { conversationId: CID, content: 'ab', final: false },
    ])
    agg.destroy()
  })

  test('超长拆分：达上限切出 final=true，余量续为下一条', () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, { debounceMs: 100, minEditIntervalMs: 0, maxChunkChars: 10 })

    agg.push(CID, '0123456789ABCDE') // 15 字符，无换行 → 硬切在 10
    expect(events).toEqual([{ conversationId: CID, content: '0123456789', final: true }])

    agg.flush(CID) // 余量 'ABCDE'
    expect(events).toEqual([
      { conversationId: CID, content: '0123456789', final: true },
      { conversationId: CID, content: 'ABCDE', final: true },
    ])
    agg.destroy()
  })

  test('拆分优先在换行处切', () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, { debounceMs: 100, minEditIntervalMs: 0, maxChunkChars: 10 })

    agg.push(CID, '012345\n6789ABC') // 换行在 index 6（>= max/2=5）→ 含入前段切在 7
    agg.flush(CID)

    expect(events).toEqual([
      { conversationId: CID, content: '012345\n', final: true },
      { conversationId: CID, content: '6789ABC', final: true },
    ])
    agg.destroy()
  })

  test('拆分后余量继续累积，flush 收尾', () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, { debounceMs: 100, minEditIntervalMs: 0, maxChunkChars: 10 })

    agg.push(CID, '01234') // 5 < 10，不拆
    expect(events).toEqual([])
    agg.push(CID, '56789AB') // 累计 12 >= 10 → 切出 '0123456789'，余 'AB'
    expect(events).toEqual([{ conversationId: CID, content: '0123456789', final: true }])

    agg.push(CID, 'C') // 余量 'ABC'
    agg.flush(CID)
    expect(events[1]).toEqual({ conversationId: CID, content: 'ABC', final: true })
    agg.destroy()
  })

  test('多会话隔离：各自缓冲与 flush', () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, { debounceMs: 100, minEditIntervalMs: 0, maxChunkChars: 100 })
    const c2 = 'conv-2' as ConversationId

    agg.push(CID, 'A')
    agg.push(c2, 'B')
    agg.flush(CID)
    agg.flush(c2)

    expect(events).toEqual([
      { conversationId: CID, content: 'A', final: true },
      { conversationId: c2, content: 'B', final: true },
    ])
    agg.destroy()
  })

  test('destroy：清定时器，之后无迟到 emit', async () => {
    const bus = createEventBus()
    const events = capture(bus)
    const agg = createMessageAggregator(bus, { debounceMs: 10, minEditIntervalMs: 0, maxChunkChars: 100 })

    agg.push(CID, 'x')
    agg.destroy() // debounce 未到即销毁
    await wait(25)

    expect(events).toEqual([])
  })
})
