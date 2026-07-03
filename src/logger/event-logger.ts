/**
 * 事件日志桥 —— 订阅总线全部事件，转结构化日志（CLAUDE.md §5.7 / 依赖矩阵：logger 订阅全部事件）。
 * 级别路由：ErrorOccurred → error；高频流式 MessageGenerated → debug；其余 → info。
 * 返回 Unsubscribe 以便优雅关闭时整体摘除（M9）。
 */
import type { Logger } from 'pino'
import { ALL_EVENT_TYPES, type EventBus, type EventType } from '../event'

/** 每类事件的日志级别。未列出者默认 info。 */
const LEVEL_BY_EVENT: Partial<Record<EventType, 'debug' | 'info' | 'error'>> = {
  MessageGenerated: 'debug', // 流式增量，量大，压到 debug 避免刷屏
  ErrorOccurred: 'error',
}

export function attachEventLogger(bus: EventBus, logger: Logger): () => void {
  const log = logger.child({ src: 'event' })
  const offs = ALL_EVENT_TYPES.map(type =>
    bus.on(type, payload => {
      const level = LEVEL_BY_EVENT[type] ?? 'info'
      log[level]({ event: type, ...payload }, type)
    }),
  )
  return () => offs.forEach(off => off())
}
