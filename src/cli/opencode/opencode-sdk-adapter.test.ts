import { describe, expect, test } from 'bun:test'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { createOpenCodeSdkAdapter } from './opencode-sdk-adapter'
import type { ApprovalRequest, OutputDelta, SpawnOptions } from '..'

const SPAWN: SpawnOptions = { conversationId: 'c1' as SpawnOptions['conversationId'], cwd: '/tmp/project' }

function createEventQueue() {
  const events: unknown[] = []
  const waiters: Array<() => void> = []
  let closed = false

  async function* stream(): AsyncGenerator<unknown> {
    for (;;) {
      while (events.length) yield events.shift()!
      if (closed) return
      await new Promise<void>(resolve => waiters.push(resolve))
    }
  }

  return {
    stream: stream(),
    push(event: unknown) {
      events.push(event)
      waiters.shift()?.()
    },
    close() {
      closed = true
      waiters.shift()?.()
    },
  }
}

function createFakeOpenCode() {
  const queue = createEventQueue()
  const prompts: string[] = []
  const contexts: string[] = []
  const promptOptions: Array<{ agent?: string; system?: string }> = []
  const permissions: Array<{ permissionID: string; response: string }> = []
  const aborts: string[] = []
  const closed: boolean[] = []
  let capturedConfig: unknown

  const client = {
    session: {
      create: () => Promise.resolve({ data: { id: 's1' }, error: undefined }),
      promptAsync: (opts: {
        body?: { agent?: string; system?: string; parts: Array<{ type: 'text'; text: string }> }
      }) => {
        prompts.push(opts.body?.parts[0]?.text ?? '')
        promptOptions.push({ agent: opts.body?.agent, system: opts.body?.system })
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
      subscribe: () => Promise.resolve({ stream: queue.stream }),
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
    capturedConfig: () => capturedConfig,
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

describe('OpenCodeSdkAdapter', () => {
  test('start creates an opencode session and injects system guardrails', async () => {
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
    expect(JSON.stringify(fake.capturedConfig())).toContain('请默认使用中文回复用户。')
    expect(JSON.stringify(fake.capturedConfig())).toContain('Never claim a filesystem or shell operation succeeded')
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
