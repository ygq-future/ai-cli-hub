// event —— Event Bus + EventMap（模块间唯一通信枢纽）。
// 契约见 docs/03-Interface-Contracts.md §1。
export { createEventBus } from './bus'
export { ALL_EVENT_TYPES } from './event-map'
export type { EventBus, EventMap, EventType } from './event-map'
