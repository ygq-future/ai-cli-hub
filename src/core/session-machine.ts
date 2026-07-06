/**
 * SessionMachine —— 纯函数状态机（docs/02-Architecture.md §5.2）。
 *
 * 映射 (currentState, event) → newState，非法迁移抛错。
 * 纯函数，无副作用，便于测试。
 */
import type { SessionStatus } from '../shared'

/** 状态机事件（与 EventMap 事件名区分，这里是状态机内部语义事件）。 */
export type SessionEvent =
  | 'SESSION_CREATED' // 会话记录写入 DB 后
  | 'START'
  | 'ADAPTER_READY' // Runtime/SDK Adapter 就绪（对应架构图中 PTYStarted）
  | 'IDLE_TIMEOUT' // 进程空闲超时回收
  | 'CLOSE' // 用户主动 /close
  | 'ARCHIVE_TIMEOUT' // 归档超时
  | 'ARCHIVE_DONE' // 归档完成（episodic 摘要生成后）

/** 合法迁移表。key 格式 `${currentState}->${event}`，value 是 newState。 */
const TRANSITIONS: Record<string, SessionStatus> = {
  'idle->SESSION_CREATED': 'idle',
  'idle->START': 'starting',
  'starting->ADAPTER_READY': 'running',
  'running->IDLE_TIMEOUT': 'idle',
  'running->CLOSE': 'closing',
  'idle->CLOSE': 'closing',
  'closing->ARCHIVE_DONE': 'closed',
  'idle->ARCHIVE_TIMEOUT': 'closing',
}

/** 终态集合（不可再迁移）。 */
const TERMINAL_STATES: ReadonlySet<SessionStatus> = new Set(['closed'])

/**
 * 执行状态迁移。纯函数。
 * @param current 当前状态
 * @param event 触发事件
 * @returns 迁移后的新状态
 * @throws 若当前已是终态或迁移不合法
 */
export function transition(current: SessionStatus, event: SessionEvent): SessionStatus {
  if (TERMINAL_STATES.has(current)) {
    throw new Error(`SessionMachine: 终态(${current}) 不可再发生事件 ${event}`)
  }

  const key = `${current}->${event}`
  const next = TRANSITIONS[key]
  if (next === undefined) {
    throw new Error(`SessionMachine: 非法迁移 ${current} -> ${event}`)
  }
  return next
}

/** 获取所有合法的目标状态（供测试/枚举用）。 */
export function getValidTransitions(): Record<string, SessionStatus> {
  return { ...TRANSITIONS }
}

/** 获取合法迁移的键列表（供测试驱动）。 */
export function getValidTransitionKeys(): string[] {
  return Object.keys(TRANSITIONS)
}
