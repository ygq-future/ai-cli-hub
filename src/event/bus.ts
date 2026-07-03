/**
 * EventBus 的进程内实现（同步、类型安全）。
 * 设计要点：
 * - emit 遍历订阅者快照（迭代期间可安全 on/off，不受增删影响）。
 * - 单个订阅者抛错被隔离，转成 ErrorOccurred 事件（见 CLAUDE.md §5.7），
 *   绝不因一个坏订阅者中断其余订阅者——事件总线是对话主链路，必须健壮。
 * - ErrorOccurred 自身订阅者抛错不再回环 emit，避免无限递归。
 */
import type { EventBus, EventMap, EventType } from './event-map'
import type { Unsubscribe } from '../shared'

type AnyHandler = (payload: unknown) => void

export function createEventBus(): EventBus {
  const handlers = new Map<EventType, Set<AnyHandler>>()

  function emit<E extends EventType>(type: E, payload: EventMap[E]): void {
    const set = handlers.get(type)
    if (!set || set.size === 0) return
    // 快照：订阅者可能在回调中取消订阅或订阅新事件
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch (cause) {
        if (type === 'ErrorOccurred') continue // 避免错误处理回环
        emit('ErrorOccurred', {
          scope: `eventbus:${type}`,
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        })
      }
    }
  }

  function on<E extends EventType>(type: E, handler: (p: EventMap[E]) => void): Unsubscribe {
    let set = handlers.get(type)
    if (!set) {
      set = new Set()
      handlers.set(type, set)
    }
    const anyHandler = handler as AnyHandler
    set.add(anyHandler)
    return () => {
      set.delete(anyHandler)
      if (set.size === 0) handlers.delete(type)
    }
  }

  function once<E extends EventType>(type: E, handler: (p: EventMap[E]) => void): Unsubscribe {
    const off = on(type, p => {
      off()
      handler(p)
    })
    return off
  }

  return { emit, on, once }
}
