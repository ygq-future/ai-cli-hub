import { describe, expect, test } from 'bun:test'
import { transition, getValidTransitions, getValidTransitionKeys } from './session-machine'
import type { SessionEvent } from './session-machine'
import type { SessionStatus } from '../shared'

describe('SessionMachine', () => {
  // ---- 合法迁移 ----
  const validCases: [SessionStatus, SessionEvent, SessionStatus][] = [
    ['idle', 'SESSION_CREATED', 'idle'],
    ['idle', 'START', 'starting'],
    ['starting', 'ADAPTER_READY', 'running'],
    ['running', 'IDLE_TIMEOUT', 'idle'],
    ['running', 'CLOSE', 'closing'],
    ['idle', 'CLOSE', 'closing'],
    ['closing', 'ARCHIVE_DONE', 'closed'],
    ['idle', 'ARCHIVE_TIMEOUT', 'closing'],
  ]

  test.each(validCases)('合法迁移: %s -> %s -> %s', (current, event, expected) => {
    expect(transition(current, event)).toBe(expected)
  })

  // ---- 非法迁移 ----
  const invalidCases: [SessionStatus, SessionEvent][] = [
    ['idle', 'ADAPTER_READY'],
    ['idle', 'IDLE_TIMEOUT'],
    ['idle', 'ARCHIVE_DONE'],
    ['starting', 'SESSION_CREATED'],
    ['starting', 'START'],
    ['starting', 'IDLE_TIMEOUT'],
    ['starting', 'CLOSE'],
    ['starting', 'ARCHIVE_TIMEOUT'],
    ['starting', 'ARCHIVE_DONE'],
    ['running', 'SESSION_CREATED'],
    ['running', 'START'],
    ['running', 'ADAPTER_READY'],
    ['running', 'ARCHIVE_TIMEOUT'],
    ['running', 'ARCHIVE_DONE'],
    ['closing', 'SESSION_CREATED'],
    ['closing', 'START'],
    ['closing', 'ADAPTER_READY'],
    ['closing', 'IDLE_TIMEOUT'],
    ['closing', 'CLOSE'],
    ['closing', 'ARCHIVE_TIMEOUT'],
  ]

  test.each(invalidCases)('非法迁移抛错: %s -> %s', (current, event) => {
    expect(() => transition(current, event)).toThrow('SessionMachine: 非法迁移')
  })

  // ---- 终态不可再迁移 ----
  const terminalEvents: SessionEvent[] = [
    'SESSION_CREATED',
    'START',
    'ADAPTER_READY',
    'IDLE_TIMEOUT',
    'CLOSE',
    'ARCHIVE_TIMEOUT',
    'ARCHIVE_DONE',
  ]

  test.each(terminalEvents)('终态 closed 不可再迁移: closed -> %s', event => {
    expect(() => transition('closed', event)).toThrow('SessionMachine: 终态')
  })

  // ---- 辅助函数 ----
  test('getValidTransitions 返回所有合法迁移的副本', () => {
    const map = getValidTransitions()
    expect(Object.keys(map).length).toBeGreaterThan(0)
    const origSize = Object.keys(map).length
    delete (map as Record<string, string>)['idle->START']
    expect(Object.keys(getValidTransitions()).length).toBe(origSize)
  })

  test('getValidTransitionKeys 返回正确的数量', () => {
    const keys = getValidTransitionKeys()
    expect(keys.length).toBe(8)
    expect(keys).toContain('idle->START')
    expect(keys).toContain('running->IDLE_TIMEOUT')
    expect(keys).toContain('closing->ARCHIVE_DONE')
  })
})
