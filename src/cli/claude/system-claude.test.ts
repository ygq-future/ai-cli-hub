import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { resolveSystemClaudeExecutable } from './system-claude'

describe('resolveSystemClaudeExecutable', () => {
  test('优先使用配置的绝对路径', () => {
    const configured = path.resolve('fake-system-bin', 'claude')
    const result = resolveSystemClaudeExecutable(configured, {
      exists: value => value === configured,
      which: () => path.resolve('other-bin', 'claude'),
    })

    expect(result).toBe(configured)
  })

  test('配置为空时从 PATH 查找系统 Claude', () => {
    const discovered = path.resolve('fake-path-bin', 'claude')
    const result = resolveSystemClaudeExecutable('', {
      exists: value => value === discovered,
      which: command => (command === 'claude' ? discovered : null),
    })

    expect(result).toBe(discovered)
  })

  test('找不到系统 Claude 时给出可操作错误', () => {
    expect(() =>
      resolveSystemClaudeExecutable('', {
        exists: () => false,
        which: () => null,
      }),
    ).toThrow(/系统 Claude CLI/)
  })
})
