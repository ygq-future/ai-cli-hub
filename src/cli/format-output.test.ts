import { describe, expect, test } from 'bun:test'
import type { OutputDelta } from './base'
import { formatOutputDelta } from './format-output'

describe('formatOutputDelta', () => {
  test('text 直出', () => {
    const d: OutputDelta = { kind: 'text', text: 'hello', final: false }
    expect(formatOutputDelta(d)).toBe('hello')
  })

  test('tool_result 直出', () => {
    const d: OutputDelta = { kind: 'tool_result', text: 'ls output', final: false }
    expect(formatOutputDelta(d)).toBe('ls output')
  })

  test('thinking 直出', () => {
    const d: OutputDelta = { kind: 'thinking', text: 'reasoning...', final: false }
    expect(formatOutputDelta(d)).toBe('reasoning...')
  })

  test('tool_use：合成工具行含参数 JSON', () => {
    const d: OutputDelta = {
      kind: 'tool_use',
      text: '',
      final: false,
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    }
    expect(formatOutputDelta(d)).toBe('\n🔧 Bash({"command":"ls"})\n')
  })

  test('tool_use 无参数', () => {
    const d: OutputDelta = { kind: 'tool_use', text: '', final: false, toolName: 'Read' }
    expect(formatOutputDelta(d)).toBe('\n🔧 Read()\n')
  })

  test('tool_use 无名回退 tool', () => {
    const d: OutputDelta = { kind: 'tool_use', text: '', final: false }
    expect(formatOutputDelta(d)).toBe('\n🔧 tool()\n')
  })

  test('final 收尾 delta（text 空）返回空串', () => {
    const d: OutputDelta = { kind: 'text', text: '', final: true }
    expect(formatOutputDelta(d)).toBe('')
  })
})
