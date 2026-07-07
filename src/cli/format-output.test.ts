import { describe, expect, test } from 'bun:test'
import type { OutputDelta } from './base'
import { formatOutputDelta } from './format-output'

describe('formatOutputDelta', () => {
  test('text 直出', () => {
    const d: OutputDelta = { kind: 'text', text: 'hello', final: false }
    expect(formatOutputDelta(d)).toBe('hello')
  })

  test('tool_result 不展示给用户', () => {
    const d: OutputDelta = { kind: 'tool_result', text: 'ls output', final: false }
    expect(formatOutputDelta(d)).toBe('')
  })

  test('thinking 不展示给用户', () => {
    const d: OutputDelta = { kind: 'thinking', text: 'reasoning...', final: false }
    expect(formatOutputDelta(d)).toBe('')
  })

  test('清理泄露的 think 标签', () => {
    const d: OutputDelta = { kind: 'text', text: "</think>I'm Claude.", final: false }
    expect(formatOutputDelta(d)).toBe("I'm Claude.")
  })

  test('清理完整 think 块', () => {
    const d: OutputDelta = { kind: 'text', text: '<think>hidden</think>visible', final: false }
    expect(formatOutputDelta(d)).toBe('visible')
  })

  test('清理泄露的系统角色和技能检查提示', () => {
    const d: OutputDelta = {
      kind: 'text',
      text: 'If you see the message "This tool does not support running in the background", check TaskList first — the task may already exist and must be claimed rather than spawned again.\n\nIf task tool is available, create tasks to track implementation progress. Always get task status via TaskList at the start of each turn.\n\n<system-role>hidden</system-role>\n让我先看看相关技能是否适用...\n你好！',
      final: false,
    }
    expect(formatOutputDelta(d)).toBe('你好！')
  })

  test('清理 Claude Code skill harness 泄露到 text block 的内容', () => {
    const d: OutputDelta = {
      kind: 'text',
      text: `\n\nIMPORTANT: Skills are loaded into the conversation separately via the 'Skill' tool. When you use the 'Skill' tool, its content replaces the tool call in the conversation and is presented to you as new instructions to follow. Your output as you invoke a skill should simply be that you're loading it — no need to describe it.\n\n## Skill usage for this turn\n\nBased on the user's message, analyze if any skills apply. The user said: "hello"\n\nGiven this is a greeting/start of conversation, I should check if skills apply. The "using-superpowers" skill was already loaded (this system reminder context contains its full instructions). Let me consider other skills that might apply - none seem to for a simple greeting.</think>你好！有什么我可以帮你的吗？`,
      final: false,
    }

    expect(formatOutputDelta(d)).toBe('你好！有什么我可以帮你的吗？')
  })

  test('清理 Claude Code 宿主记忆与 active agents 前缀泄露', () => {
    const d: OutputDelta = {
      kind: 'text',
      text: ` 

# Safety

- hidden safety text

# Skills
hidden skills text

# Memory

- [memory.md](file:///D:/Users/example/memory.md) — hidden memory

# CLAUDE.md

<file path="D:\\Users\\example\\CLAUDE.md" content="hidden">

# Active background agents

- Researcher | ID: a_123 | output: hidden</think>你好！有什么我可以帮你的吗？`,
      final: false,
    }

    expect(formatOutputDelta(d)).toBe('你好！有什么我可以帮你的吗？')
  })

  test('清理缺失开头标签的 system-reminder 尾段泄露', () => {
    const d: OutputDelta = {
      kind: 'text',
      text: `Wait for all results before deciding next steps.

For the Workflow tool, available workflow names are: code-review, comprehensive-audit.
</system-reminder>

你好！我是 Claude Code，Anthropic 官方 CLI 工具。`,
      final: false,
    }

    expect(formatOutputDelta(d)).toBe('你好！我是 Claude Code，Anthropic 官方 CLI 工具。')
  })

  test('清理任意缺头 system-reminder 残片', () => {
    const d: OutputDelta = {
      kind: 'text',
      final: true,
      text: ` If they are not independent (e.g. agent B depends on agent A's output), launch them sequentially.
</system-reminder> 你好！今天有什么可以帮你的？`,
    }

    expect(formatOutputDelta(d)).toBe('你好！今天有什么可以帮你的？')
  })

  test('清理 Claude Code 宿主 system-role 与全局技能清单泄露', () => {
    const d: OutputDelta = {
      kind: 'text',
      final: true,
      text: `Do not launch two agents on the same scope of work or with the same instruction unless you need independent diverse results (panel check, tournament). One agent per scope or answer dimension.

Use \`SendMessage\` to communicate with background agents.

IMPORTANT SYSTEM-ROLE / CROSS-CUTTING INSTRUCTIONS:
# Output Standards

## 文件变更输出规范

## 可用的全局技能

- \`memory:memory\` — 记忆处理。

## Available slash commands (skills) and their descriptions

- /memory — 读取或更新长期记忆。

你好！我是 Claude Code，你的 AI CLI 远程会话管理助手。有什么可以帮你的吗？`,
    }

    expect(formatOutputDelta(d)).toBe('你好！我是 Claude Code，你的 AI CLI 远程会话管理助手。有什么可以帮你的吗？')
  })

  test('tool_use 不展示给用户', () => {
    const d: OutputDelta = {
      kind: 'tool_use',
      text: '',
      final: false,
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    }
    expect(formatOutputDelta(d)).toBe('')
  })

  test('tool_use 无参数也不展示', () => {
    const d: OutputDelta = { kind: 'tool_use', text: '', final: false, toolName: 'Read' }
    expect(formatOutputDelta(d)).toBe('')
  })

  test('tool_use 无名也不展示', () => {
    const d: OutputDelta = { kind: 'tool_use', text: '', final: false }
    expect(formatOutputDelta(d)).toBe('')
  })

  test('final 收尾 delta（text 空）返回空串', () => {
    const d: OutputDelta = { kind: 'text', text: '', final: true }
    expect(formatOutputDelta(d)).toBe('')
  })
})
