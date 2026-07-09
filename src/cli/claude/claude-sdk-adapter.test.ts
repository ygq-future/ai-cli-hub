import { describe, expect, test } from 'bun:test'
import type { CanUseTool, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeSdkAdapter } from './claude-sdk-adapter'
import type { OutputDelta, SpawnOptions } from '..'

const SPAWN: SpawnOptions = { conversationId: 'c1' as SpawnOptions['conversationId'], cwd: '/tmp' }

/** 构建一个假 Query，产出给定消息列表。 */
function fakeQuery(
  msgs: SDKMessage[],
  captureCanUse?: (fn: CanUseTool) => void,
  captureOptions?: (options: Options) => void,
) {
  return ((params: { options?: Options }) => {
    if (params.options) captureOptions?.(params.options)
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
function fakeQueryOpen(captureCanUse?: (fn: CanUseTool) => void, captureOptions?: (options: Options) => void) {
  return ((params: { options?: Options }) => {
    if (params.options) captureOptions?.(params.options)
    if (params.options?.canUseTool) captureCanUse?.(params.options.canUseTool)
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
  test('输出映射：assistant/user 协议消息不展示，result.result 作为最终回复', async () => {
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

    expect(out).toEqual([{ kind: 'text', text: 'done', final: true }])
  })

  test('result.result 为空或清洗后为空时输出可见兜底消息', async () => {
    const a = createClaudeSdkAdapter({
      queryFn: fakeQuery([
        { type: 'result', subtype: 'success', result: '', is_error: false } as unknown as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          result: '<system-reminder>hidden</system-reminder>',
          is_error: false,
        } as unknown as SDKMessage,
      ]),
    })
    const out: OutputDelta[] = []
    a.onOutput(d => out.push(d))

    await a.start(SPAWN)
    await tick()

    expect(out).toEqual([
      { kind: 'text', text: '本轮没有生成可见回复，请重试。', final: true },
      { kind: 'text', text: '本轮没有生成可见回复，请重试。', final: true },
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
    const allow3 = canUse!('Bash', { command: 'ls -la /d/' }, { toolUseID: 't3' } as never)
    const deny = canUse!('Write', { file_path: '/y' }, { toolUseID: 't4' } as never)
    const deny2 = canUse!('Bash', { command: 'rm -rf' }, { toolUseID: 't5' } as never)

    // 只读工具同步 allow，返回 include updatedInput（SDK 要求 allow 传 updatedInput）
    expect(await allow1).toEqual({ behavior: 'allow', updatedInput: { file_path: '/x' }, toolUseID: 't1' })
    expect(await allow2).toEqual({ behavior: 'allow', updatedInput: { pattern: '*.ts' }, toolUseID: 't2' })
    expect(await allow3).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la /d/' }, toolUseID: 't3' })

    await tick()
    // 写操作弹了审批请求，还没有决议
    expect(reqs.length).toBe(2)
    expect(a.getState()).toBe('waitingApproval')

    // 审批后决议
    a.resolveApproval('t4', 'approve')
    a.resolveApproval('t5', 'reject')
    expect(await deny).toEqual({ behavior: 'allow', updatedInput: { file_path: '/y' }, toolUseID: 't4' })
    expect(await deny2).toEqual({
      behavior: 'deny',
      message: 'User rejected this tool use. Stop the current turn.',
      toolUseID: 't5',
    })
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

    expect(out).toEqual([{ kind: 'text', text: 'done', final: true }])
  })

  test('中断后状态变为 stopped', async () => {
    const a = createClaudeSdkAdapter({ queryFn: fakeQueryOpen() })
    await a.start(SPAWN)
    expect(a.getState()).toBe('ready')
    await a.stop()
    expect(a.getState()).toBe('stopped')
  })

  test('systemLanguageHint 与操作结果护栏追加到 Claude Code 默认 systemPrompt', async () => {
    let systemPrompt: unknown
    const a = createClaudeSdkAdapter({
      queryFn: fakeQuery([], undefined, options => {
        systemPrompt = options.systemPrompt
      }),
    })

    await a.start({ ...SPAWN, systemLanguageHint: '请默认使用中文回复用户。' })
    await tick()

    expect(systemPrompt).toMatchObject({
      type: 'preset',
      preset: 'claude_code',
    })
    const append = (systemPrompt as { append: string }).append
    expect(append).toContain('请默认使用中文回复用户。')
    expect(append).toContain('Never claim a filesystem or shell operation succeeded')
  })

  test('未指定语言时仍注入操作结果护栏', async () => {
    let systemPrompt: unknown
    const a = createClaudeSdkAdapter({
      queryFn: fakeQuery([], undefined, options => {
        systemPrompt = options.systemPrompt
      }),
    })

    await a.start(SPAWN)
    await tick()

    expect(systemPrompt).toMatchObject({
      type: 'preset',
      preset: 'claude_code',
    })
    expect((systemPrompt as { append: string }).append).toContain('Remote operation guardrail')
  })

  test('默认隔离宿主 plugins/skills，但保留 SDK 默认 settingSources 以复用 Claude CLI 认证', async () => {
    let options: Options | undefined
    const a = createClaudeSdkAdapter({
      queryFn: fakeQuery([], undefined, captured => {
        options = captured
      }),
    })

    await a.start(SPAWN)
    await tick()

    expect(options?.settingSources).toBeUndefined()
    expect(options?.skills).toEqual([])
    expect(options?.plugins).toEqual([])
    expect(options?.strictMcpConfig).toBe(true)
    expect(options?.settings).toMatchObject({
      disableBundledSkills: true,
      disableAllHooks: true,
    })
  })

  test('debugRawJson 开启后记录 SDK 原始消息 JSON', async () => {
    const rawMessages: string[] = []
    const a = createClaudeSdkAdapter({
      queryFn: fakeQuery([assistant([textBlock('hi')]), resultMsg()]),
      debugRawJson: true,
      rawMessageLogger: rawJson => rawMessages.push(rawJson),
    })

    await a.start(SPAWN)
    await tick()

    expect(rawMessages.length).toBe(2)
    expect(JSON.parse(rawMessages[0]!) as Record<string, unknown>).toMatchObject({ type: 'assistant' })
    expect(JSON.parse(rawMessages[1]!) as Record<string, unknown>).toMatchObject({
      type: 'result',
      result: 'done',
      result_raw_omitted: true,
      result_raw_chars: 4,
    })
  })

  test('debugRawJson 过滤高频 thinking_tokens 系统消息', async () => {
    const rawMessages: string[] = []
    const a = createClaudeSdkAdapter({
      queryFn: fakeQuery([
        {
          type: 'system',
          subtype: 'thinking_tokens',
          estimated_tokens: 1,
          estimated_tokens_delta: 1,
        } as unknown as SDKMessage,
        resultMsg(),
      ]),
      debugRawJson: true,
      rawMessageLogger: rawJson => rawMessages.push(rawJson),
    })

    await a.start(SPAWN)
    await tick()

    expect(rawMessages.length).toBe(1)
    expect(JSON.parse(rawMessages[0]!) as Record<string, unknown>).toMatchObject({ type: 'result' })
  })

  test('debugRawJson 默认关闭时不记录 SDK 原始消息', async () => {
    const rawMessages: string[] = []
    const a = createClaudeSdkAdapter({
      queryFn: fakeQuery([assistant([textBlock('hi')]), resultMsg()]),
      rawMessageLogger: rawJson => rawMessages.push(rawJson),
    })

    await a.start(SPAWN)
    await tick()

    expect(rawMessages).toEqual([])
  })
})
