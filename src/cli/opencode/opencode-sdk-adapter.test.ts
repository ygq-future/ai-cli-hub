import { describe, expect, test } from 'bun:test'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { createOpenCodeSdkAdapter } from './opencode-sdk-adapter'
import { createOpenCodeServerPool } from './opencode-server-pool'
import type { ApprovalRequest, OutputDelta, SpawnOptions } from '..'

const SPAWN: SpawnOptions = { conversationId: 'c1' as SpawnOptions['conversationId'], cwd: '/tmp/project' }

function createEventQueue() {
  const events: unknown[] = []
  const waiters = new Set<() => void>()
  let closed = false

  function stream(signal?: AbortSignal) {
    let nextIndex = 0
    return (async function* (): AsyncGenerator<unknown> {
      for (;;) {
        while (nextIndex < events.length) yield events[nextIndex++]
        if (closed || signal?.aborted) return
        await new Promise<void>(resolve => {
          const wake = () => {
            waiters.delete(wake)
            resolve()
          }
          waiters.add(wake)
          signal?.addEventListener('abort', wake, { once: true })
        })
      }
    })()
  }

  function wakeAll() {
    for (const resolve of waiters) {
      waiters.delete(resolve)
      resolve()
    }
  }

  return {
    stream,
    push(event: unknown) {
      events.push(event)
      wakeAll()
    },
    close() {
      closed = true
      wakeAll()
    },
  }
}

function createFakeOpenCode() {
  const queue = createEventQueue()
  const prompts: string[] = []
  const contexts: string[] = []
  const promptOptions: Array<{ agent?: string; system?: string; model?: { providerID: string; modelID: string } }> = []
  const permissions: Array<{ permissionID: string; response: string }> = []
  const aborts: string[] = []
  const closed: boolean[] = []
  const sessionIds: string[] = []
  let starts = 0
  let nextSession = 1
  let capturedConfig: unknown

  const client = {
    session: {
      create: () => {
        const id = `s${nextSession++}`
        sessionIds.push(id)
        return Promise.resolve({ data: { id }, error: undefined })
      },
      promptAsync: (opts: {
        body?: {
          agent?: string
          system?: string
          model?: { providerID: string; modelID: string }
          parts: Array<{ type: 'text'; text: string }>
        }
      }) => {
        prompts.push(opts.body?.parts[0]?.text ?? '')
        promptOptions.push({ agent: opts.body?.agent, system: opts.body?.system, model: opts.body?.model })
        return Promise.resolve({ data: undefined, error: undefined })
      },
      prompt: (opts: { body?: { noReply?: boolean; parts: Array<{ type: 'text'; text: string }> } }) => {
        if (opts.body?.noReply) contexts.push(opts.body.parts[0]?.text ?? '')
        return Promise.resolve({ data: undefined, error: undefined })
      },
      abort: (opts: { path: { id: string } }) => {
        aborts.push(opts.path.id)
        return Promise.resolve({ data: true, error: undefined })
      },
    },
    event: {
      subscribe: (opts: { signal?: AbortSignal }) => Promise.resolve({ stream: queue.stream(opts.signal) }),
    },
    provider: {
      list: () =>
        Promise.resolve({
          data: {
            connected: ['deepseek'],
            default: { deepseek: 'deepseek-v4' },
            all: [
              {
                id: 'deepseek',
                name: 'DeepSeek',
                env: [],
                models: {
                  'deepseek-v4': {
                    id: 'deepseek-v4',
                    name: 'DeepSeek V4',
                    release_date: '2026-01-01',
                    attachment: false,
                    reasoning: true,
                    temperature: true,
                    tool_call: true,
                    limit: { context: 128000, output: 8192 },
                    options: {},
                  },
                },
              },
            ],
          },
          error: undefined,
        }),
    },
    postSessionIdPermissionsPermissionId: (opts: {
      path: { id: string; permissionID: string }
      body?: { response: string }
    }) => {
      permissions.push({ permissionID: opts.path.permissionID, response: opts.body?.response ?? '' })
      return Promise.resolve({ data: true, error: undefined })
    },
  } as unknown as OpencodeClient

  const createOpencodeFn = async (opts?: { config?: unknown }) => {
    starts += 1
    capturedConfig = opts?.config
    return {
      client,
      server: {
        url: 'http://127.0.0.1:4096',
        close() {
          closed.push(true)
          queue.close()
        },
      },
    }
  }

  return {
    createOpencodeFn,
    queue,
    prompts,
    contexts,
    promptOptions,
    permissions,
    aborts,
    closed,
    sessionIds,
    starts: () => starts,
    capturedConfig: () => capturedConfig,
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

describe('OpenCodeSdkAdapter', () => {
  test('start creates an opencode session with reusable shared-server config', async () => {
    const fake = createFakeOpenCode()
    const adapter = createOpenCodeSdkAdapter({ createOpencodeFn: fake.createOpencodeFn })

    await adapter.start({ ...SPAWN, systemLanguageHint: '请默认使用中文回复用户。' })
    await tick()

    expect(adapter.cliType).toBe('opencode')
    expect(adapter.getState()).toBe('ready')
    expect(fake.capturedConfig()).toMatchObject({
      permission: { edit: 'ask', bash: 'ask' },
      instructions: [],
      agent: {
        ai_cli_hub: {
          mode: 'primary',
          permission: { edit: 'ask', bash: 'ask' },
        },
      },
    })
    expect(JSON.stringify(fake.capturedConfig())).not.toContain('请默认使用中文回复用户。')
    expect(JSON.stringify(fake.capturedConfig())).toContain('"prompt":""')
  })

  test('two adapters share a provided server while retaining separate adapter lifecycles', async () => {
    const fake = createFakeOpenCode()
    const serverPool = createOpenCodeServerPool({ createOpencodeFn: fake.createOpencodeFn })
    const first = createOpenCodeSdkAdapter({ serverPool })
    const second = createOpenCodeSdkAdapter({ serverPool })

    await Promise.all([
      first.start({ ...SPAWN, conversationId: 'first' as SpawnOptions['conversationId'] }),
      second.start({ ...SPAWN, conversationId: 'second' as SpawnOptions['conversationId'] }),
    ])
    expect(fake.starts()).toBe(1)
    expect(fake.sessionIds).toEqual(['s1', 's2'])

    await first.stop()
    expect(fake.closed).toEqual([])
    await second.stop()
    expect(fake.closed).toEqual([true])
  })

  test('sendUserInput posts prompt and streams visible text until session idle finalizes the turn', async () => {
    const fake = createFakeOpenCode()
    const adapter = createOpenCodeSdkAdapter({ createOpencodeFn: fake.createOpencodeFn })
    const out: OutputDelta[] = []
    adapter.onOutput(delta => out.push(delta))

    await adapter.start({ ...SPAWN, systemLanguageHint: '请默认使用中文回复用户。' })
    adapter.sendUserInput('hello')
    await tick()
    fake.queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'm1',
          sessionID: 's1',
          role: 'assistant',
        },
      },
    })
    fake.queue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'hi',
        },
        delta: 'hi',
      },
    })
    fake.queue.push({ type: 'session.idle', properties: { sessionID: 's1' } })
    await tick()

    expect(fake.prompts).toEqual(['hello'])
    expect(fake.promptOptions).toEqual([
      {
        agent: 'ai_cli_hub',
        system: expect.stringContaining('请默认使用中文回复用户。') as string,
      },
    ])
    expect(out).toEqual([
      { kind: 'text', text: 'hi', final: false },
      { kind: 'text', text: '', final: true },
    ])
  })

  test('列出已连接 provider 的模型并把持久化选择用于后续 prompt', async () => {
    const fake = createFakeOpenCode()
    const adapter = createOpenCodeSdkAdapter({ createOpencodeFn: fake.createOpencodeFn })

    await adapter.start(SPAWN)
    expect(await adapter.listModels()).toEqual([
      {
        id: 'deepseek/deepseek-v4',
        name: 'DeepSeek · DeepSeek V4',
        description: '128000 context · 8192 max output',
      },
    ])
    expect(await adapter.setModel('deepseek/deepseek-v4')).toBe('deepseek/deepseek-v4')
    adapter.sendUserInput('hello')
    await tick()
    expect(fake.promptOptions[0]?.model).toEqual({ providerID: 'deepseek', modelID: 'deepseek-v4' })
    await expect(adapter.setModel('missing/model')).rejects.toThrow('model is not available')
    await adapter.stop()
  })

  test('user text parts are never emitted as assistant output across consecutive prompts', async () => {
    const fake = createFakeOpenCode()
    const adapter = createOpenCodeSdkAdapter({ createOpencodeFn: fake.createOpencodeFn })
    const out: OutputDelta[] = []
    adapter.onOutput(delta => out.push(delta))

    await adapter.start(SPAWN)
    adapter.sendUserInput('hello')
    fake.queue.push({
      type: 'message.updated',
      properties: { info: { id: 'user-1', sessionID: 's1', role: 'user' } },
    })
    fake.queue.push({
      type: 'message.part.updated',
      properties: {
        part: { id: 'user-part-1', sessionID: 's1', messageID: 'user-1', type: 'text', text: 'hello' },
      },
    })
    adapter.sendUserInput('看一下我的powershell脚本在哪里,')
    fake.queue.push({
      type: 'message.updated',
      properties: { info: { id: 'user-2', sessionID: 's1', role: 'user' } },
    })
    fake.queue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'user-part-2',
          sessionID: 's1',
          messageID: 'user-2',
          type: 'text',
          text: '看一下我的powershell脚本在哪里,',
        },
      },
    })
    await tick()

    expect(out).toEqual([])
  })

  test('sendContext injects noReply context without sending it as visible user input', async () => {
    const fake = createFakeOpenCode()
    const adapter = createOpenCodeSdkAdapter({ createOpencodeFn: fake.createOpencodeFn })
    const out: OutputDelta[] = []
    adapter.onOutput(delta => out.push(delta))

    await adapter.start(SPAWN)
    await adapter.sendContext?.('[最近对话上下文]\n- 用户：old')
    fake.queue.push({
      type: 'message.updated',
      properties: { info: { id: 'm-hidden', sessionID: 's1', role: 'user' } },
    })
    fake.queue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'hidden-context',
          sessionID: 's1',
          messageID: 'm-hidden',
          type: 'text',
          text: '[最近对话上下文]\n- 用户：old',
        },
      },
    })
    adapter.sendUserInput('hello')
    await tick()

    expect(fake.contexts).toEqual(['[最近对话上下文]\n- 用户：old'])
    expect(fake.prompts).toEqual(['hello'])
    expect(out).toEqual([])
  })

  test('permission.updated maps to approval request and resolveApproval posts once or reject', async () => {
    const fake = createFakeOpenCode()
    const adapter = createOpenCodeSdkAdapter({ createOpencodeFn: fake.createOpencodeFn })
    const approvals: ApprovalRequest[] = []
    adapter.onApprovalRequest(req => approvals.push(req))

    await adapter.start(SPAWN)
    fake.queue.push({
      type: 'permission.updated',
      properties: {
        id: 'perm1',
        type: 'bash',
        pattern: 'rm *',
        sessionID: 's1',
        messageID: 'm1',
        callID: 'call1',
        title: 'Run shell command',
        metadata: { command: 'rm *' },
        time: { created: Date.now() },
      },
    })
    await tick()

    expect(adapter.getState()).toBe('waitingApproval')
    expect(approvals).toEqual([
      {
        approvalId: 'perm1',
        command: 'Run shell command',
        detail: JSON.stringify({
          permission: 'bash',
          patterns: undefined,
          metadata: { command: 'rm *' },
          tool: undefined,
          always: undefined,
        }),
      },
    ])

    adapter.resolveApproval('perm1', 'approve')
    await tick()
    expect(fake.permissions).toEqual([{ permissionID: 'perm1', response: 'once' }])

    fake.queue.push({
      type: 'permission.updated',
      properties: {
        id: 'perm2',
        type: 'edit',
        sessionID: 's1',
        messageID: 'm2',
        title: 'Edit file',
        metadata: { file: 'a.ts' },
        time: { created: Date.now() },
      },
    })
    await tick()
    adapter.resolveApproval('perm2', 'reject')
    await tick()

    expect(fake.permissions).toEqual([
      { permissionID: 'perm1', response: 'once' },
      { permissionID: 'perm2', response: 'reject' },
    ])
  })

  test('read-only bash permission uses shared policy and replies once without approval', async () => {
    const fake = createFakeOpenCode()
    const adapter = createOpenCodeSdkAdapter({ createOpencodeFn: fake.createOpencodeFn })
    const approvals: ApprovalRequest[] = []
    adapter.onApprovalRequest(req => approvals.push(req))

    await adapter.start(SPAWN)
    fake.queue.push({
      type: 'permission.updated',
      properties: {
        id: 'perm-read',
        permission: 'bash',
        sessionID: 's1',
        messageID: 'm-read',
        metadata: { command: 'Get-ChildItem -Force' },
        time: { created: Date.now() },
      },
    })
    await tick()

    expect(approvals).toEqual([])
    expect(fake.permissions).toEqual([{ permissionID: 'perm-read', response: 'once' }])
    expect(adapter.getState()).toBe('busy')

    fake.queue.push({
      type: 'permission.updated',
      properties: {
        id: 'perm-web',
        permission: 'webfetch',
        sessionID: 's1',
        messageID: 'm-web',
        time: { created: Date.now() },
      },
    })
    await tick()
    expect(approvals).toEqual([])
    expect(fake.permissions).toEqual([
      { permissionID: 'perm-read', response: 'once' },
      { permissionID: 'perm-web', response: 'once' },
    ])
  })

  test('raw logger keeps actionable events and drops startup, heartbeat, message, and catalog noise', async () => {
    const fake = createFakeOpenCode()
    const raw: string[] = []
    const adapter = createOpenCodeSdkAdapter({
      createOpencodeFn: fake.createOpencodeFn,
      debugRawJson: true,
      rawMessageLogger: json => raw.push(json),
    })
    const approvals: ApprovalRequest[] = []
    const out: OutputDelta[] = []
    adapter.onApprovalRequest(req => approvals.push(req))
    adapter.onOutput(delta => out.push(delta))

    await adapter.start(SPAWN)
    fake.queue.push({ type: 'server.heartbeat', properties: {} })
    fake.queue.push({ type: 'server.connected', properties: {} })
    fake.queue.push({ type: 'plugin.added', properties: { id: 'dynamic-provider' } })
    fake.queue.push({ type: 'catalog.updated', properties: {} })
    fake.queue.push({
      type: 'message.updated',
      properties: { info: { id: 'm-user', sessionID: 's1', role: 'user', system: 'hidden system prompt' } },
    })
    fake.queue.push({
      type: 'session.status',
      properties: { sessionID: 's1', status: { type: 'busy' } },
    })
    fake.queue.push({
      type: 'session.status',
      properties: {
        sessionID: 's1',
        status: { type: 'retry', attempt: 2, message: 'Cannot connect to API', next: Date.now() + 1000 },
      },
    })
    fake.queue.push({
      type: 'message.part.delta',
      properties: {
        sessionID: 's1',
        partID: 'p-reasoning',
        field: 'text',
        delta: 'hidden reasoning',
      },
    })
    fake.queue.push({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        part: {
          id: 'p-reasoning',
          sessionID: 's1',
          messageID: 'm1',
          type: 'reasoning',
          text: 'hidden reasoning',
        },
      },
    })
    fake.queue.push({
      type: 'permission.asked',
      properties: {
        id: 'perm-edit',
        sessionID: 's1',
        permission: 'edit',
        patterns: ['opencode-smoke.txt'],
        metadata: { filepath: '/tmp/project/opencode-smoke.txt', diff: '+hello opencode' },
        tool: { messageID: 'm1', callID: 'call1' },
      },
    })
    await tick()

    expect(out).toEqual([])
    expect(raw).toHaveLength(2)
    expect(raw.join('\n')).toContain('session.status')
    expect(raw.join('\n')).toContain('Cannot connect to API')
    expect(raw.join('\n')).toContain('permission.asked')
    expect(raw.join('\n')).not.toContain('server.heartbeat')
    expect(raw.join('\n')).not.toContain('server.connected')
    expect(raw.join('\n')).not.toContain('plugin.added')
    expect(raw.join('\n')).not.toContain('catalog.updated')
    expect(raw.join('\n')).not.toContain('hidden system prompt')
    expect(raw.join('\n')).not.toContain('hidden reasoning')
    expect(adapter.getState()).toBe('waitingApproval')
    expect(approvals).toEqual([
      {
        approvalId: 'perm-edit',
        command: 'edit',
        detail: JSON.stringify({
          permission: 'edit',
          patterns: ['opencode-smoke.txt'],
          metadata: { filepath: '/tmp/project/opencode-smoke.txt', diff: '+hello opencode' },
          tool: { messageID: 'm1', callID: 'call1' },
          always: undefined,
        }),
      },
    ])

    adapter.resolveApproval('perm-edit', 'approve')
    await tick()
    expect(fake.permissions).toEqual([{ permissionID: 'perm-edit', response: 'once' }])
  })

  test('retry remains busy and session error finalizes the turn once', async () => {
    const fake = createFakeOpenCode()
    const adapter = createOpenCodeSdkAdapter({ createOpencodeFn: fake.createOpencodeFn })
    const out: OutputDelta[] = []
    adapter.onOutput(delta => out.push(delta))

    await adapter.start(SPAWN)
    adapter.sendUserInput('hello')
    fake.queue.push({
      type: 'session.status',
      properties: {
        sessionID: 's1',
        status: { type: 'retry', attempt: 1, message: 'Cannot connect to API', next: Date.now() + 1000 },
      },
    })
    await tick()
    expect(adapter.getState()).toBe('busy')

    fake.queue.push({
      type: 'session.error',
      properties: {
        sessionID: 's1',
        error: { name: 'APIError', data: { message: 'Cannot connect to API', isRetryable: false } },
      },
    })
    fake.queue.push({ type: 'session.idle', properties: { sessionID: 's1' } })
    await tick()

    expect(adapter.getState()).toBe('ready')
    expect(out).toEqual([{ kind: 'text', text: 'opencode session error: Cannot connect to API', final: true }])
  })

  test('stop aborts the session and closes the SDK server', async () => {
    const fake = createFakeOpenCode()
    const adapter = createOpenCodeSdkAdapter({ createOpencodeFn: fake.createOpencodeFn })

    await adapter.start(SPAWN)
    await adapter.stop()

    expect(fake.aborts).toEqual(['s1'])
    expect(fake.closed).toEqual([true])
    expect(adapter.getState()).toBe('stopped')
  })
})
