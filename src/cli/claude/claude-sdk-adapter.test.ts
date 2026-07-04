import { describe, expect, test } from 'bun:test'
import type { CanUseTool, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeSdkAdapter } from './claude-sdk-adapter'
import type { OutputDelta, SpawnOptions } from '../base'

const SPAWN: SpawnOptions = { conversationId: 'c1' as SpawnOptions['conversationId'], cwd: '/tmp' }

/** 构建一个假 Query，产出给定消息列表。 */
function fakeQuery(msgs: SDKMessage[], captureCanUse?: (fn: CanUseTool) => void) {
  return ((params: { options?: { canUseTool?: CanUseTool } }) => {
    if (params.options?.canUseTool) captureCanUse?.(params.options.canUseTool)
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const m of msgs) yield m
    }
    const q = gen() as unknown as Query
    q.interrupt = async () => {}
    return q
  }) as unknown as Parameters<typeof createClaudeSdkAdapter>[0] extends { queryFn?: infer F } ? F : never
}

/** 不结束的假 Query：挂起直到 interrupt。 */
function fakeQueryOpen() {
  return ((_p: unknown) => {
    let stop!: () => void
    const done = new Promise<void>(r => (stop = r))
    // eslint-disable-next-line require-yield -- intentionally hangs until interrupt
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      await done
    }
    const q = gen() as unknown as Query
    q.interrupt = async () => stop()
    return q
  }) as unknown as Parameters<typeof createClaudeSdkAdapter>[0] extends { queryFn?: infer F } ? F : never
}

/** 助手消息 helper：content 是 block 数组。 */
function assistant(blocks: Record<string, unknown>[]): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: blocks } } as unknown as SDKMessage
}

const textBlock = (t: string) => ({ type: 'text', text: t })
const toolUseBlock = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
})
const thinkingBlock = (t: string) => ({ type: 'thinking', thinking: t })
const toolResultBlock = (content: string) => ({
  type: 'tool_result',
  tool_use_id: 'x',
  content: [{ type: 'text', text: content }],
})
function resultMsg(): SDKMessage {
  return { type: 'result', subtype: 'success', result: 'done', is_error: false } as unknown as SDKMessage
}

const userMsg = (role: 'user' | 'assistant', blocks: Record<string, unknown>[]): SDKMessage =>
  ({ type: 'user', message: { role, content: blocks } }) as unknown as SDKMessage

const tick = () => new Promise(r => setTimeout(r, 5))

describe('ClaudeSdkAdapter (real message flow)', () => {
  test('输出映射：text→kind=text, tool_use→kind=tool_use, thinking→kind=thinking, result→final=true', async () => {
    const a = createClaudeSdkAdapter({
      queryFn: fakeQuery([
        assistant([textBlock('I will read it'), toolUseBlock('toolu_1', 'Read', { file_path: '/x' })]),
        userMsg('user', [toolResultBlock('file content')]),
        assistant([thinkingBlock('reasoning step'), textBlock('The result is: file content')]),
        resultMsg(),
      ]),
    })
    const out: OutputDelta[] = []
    a.onOutput(d => out.push(d))

    await a.start(SPAWN)
    await tick()

    expect(out).toEqual([
      { kind: 'text', text: 'I will read it', final: false },
      { kind: 'tool_use', text: '', final: false, toolName: 'Read', toolInput: { file_path: '/x' } },
      { kind: 'tool_result', text: 'file content', final: false },
      { kind: 'thinking', text: 'reasoning step', final: false },
      { kind: 'text', text: 'The result is: file content', final: false },
      { kind: 'text', text: '', final: true },
    ])
  })

  test('审批策略：只读工具自动 allow，写工具弹审批', async () => {
    let canUse: CanUseTool | null = null
    const a = createClaudeSdkAdapter({ queryFn: fakeQuery([], fn => (canUse = fn)) })
    const reqs: unknown[] = []
    a.onApprovalRequest(r => reqs.push(r))
    await a.start(SPAWN)
    await tick()

    const allow1 = canUse!('Read', { file_path: '/x' }, { toolUseID: 't1' } as never)
    const allow2 = canUse!('Glob', { pattern: '*.ts' }, { toolUseID: 't2' } as never)
    const deny = canUse!('Write', { file_path: '/y' }, { toolUseID: 't3' } as never)
    const deny2 = canUse!('Bash', { command: 'rm -rf' }, { toolUseID: 't4' } as never)

    // 只读工具同步 allow，返回 include updatedInput（SDK 要求 allow 传 updatedInput）
    expect(await allow1).toEqual({ behavior: 'allow', updatedInput: { file_path: '/x' }, toolUseID: 't1' })
    expect(await allow2).toEqual({ behavior: 'allow', updatedInput: { pattern: '*.ts' }, toolUseID: 't2' })

    await tick()
    // 写操作弹了审批请求，还没有决议
    expect(reqs.length).toBe(2)
    expect(a.getState()).toBe('waitingApproval')

    // 审批后决议
    a.resolveApproval('t3', 'approve')
    a.resolveApproval('t4', 'reject')
    expect(await deny).toEqual({ behavior: 'allow', updatedInput: {}, toolUseID: 't3' })
    expect(await deny2).toEqual({ behavior: 'deny', message: 'User rejected', toolUseID: 't4' })
  })

  test('system / init 消息被跳过', async () => {
    const a = createClaudeSdkAdapter({
      queryFn: fakeQuery([
        { type: 'system', subtype: 'init' } as unknown as SDKMessage,
        { type: 'system', subtype: 'hook_started' } as unknown as SDKMessage,
        resultMsg(),
      ]),
    })
    const out: OutputDelta[] = []
    a.onOutput(d => out.push(d))
    await a.start(SPAWN)
    await tick()

    expect(out).toEqual([{ kind: 'text', text: '', final: true }])
  })

  test('中断后状态变为 stopped', async () => {
    const a = createClaudeSdkAdapter({ queryFn: fakeQueryOpen() })
    await a.start(SPAWN)
    expect(a.getState()).toBe('ready')
    await a.stop()
    expect(a.getState()).toBe('stopped')
  })
})
