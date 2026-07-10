import { describe, expect, test } from 'bun:test'
import { createEventBus } from './event'
import { createMessageAggregator } from './core'
import { createSessionOrchestrator } from './orchestrator'
import type { ConversationId } from './shared'
import type { CLIAdapter, OutputDelta, ApprovalRequest, ExitInfo, SpawnOptions, ApprovalAction } from './cli'
import type { Repositories } from './repository'

const CID = 'conv-1' as ConversationId

const tick = () => new Promise(r => setTimeout(r, 0))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 假 adapter：记录调用，允许测试手动触发 output/approval/exit。 */
function createFakeAdapter(opts?: { onStop?: () => Promise<void>; contextInjection?: boolean }) {
  const outputHandlers: Array<(d: OutputDelta) => void> = []
  const approvalHandlers: Array<(r: ApprovalRequest) => void> = []
  const exitHandlers: Array<(i: ExitInfo) => void> = []
  const calls = {
    start: [] as SpawnOptions[],
    sendUserInput: [] as string[],
    sendContext: [] as string[],
    resolveApproval: [] as Array<[string, ApprovalAction]>,
    callOrder: [] as string[],
    interrupt: 0,
    stop: 0,
  }
  const adapter: CLIAdapter = {
    cliType: 'claude',
    async start(opts) {
      calls.start.push(opts)
    },
    async stop() {
      calls.stop++
      await opts?.onStop?.()
    },
    interrupt() {
      calls.interrupt++
      calls.callOrder.push('interrupt')
    },
    sendUserInput(t) {
      calls.sendUserInput.push(t)
    },
    resolveApproval(id, d) {
      calls.resolveApproval.push([id, d])
      calls.callOrder.push(`resolve:${d}`)
    },
    onOutput(h) {
      outputHandlers.push(h)
      return () => {}
    },
    onApprovalRequest(h) {
      approvalHandlers.push(h)
      return () => {}
    },
    onExit(h) {
      exitHandlers.push(h)
      return () => {}
    },
    getState: () => 'ready',
  }
  if (opts?.contextInjection) {
    adapter.sendContext = text => {
      calls.sendContext.push(text)
    }
  }
  return {
    adapter,
    calls,
    emitOutput: (d: OutputDelta) => outputHandlers.forEach(h => h(d)),
    emitApproval: (r: ApprovalRequest) => approvalHandlers.forEach(h => h(r)),
    emitExit: (i: ExitInfo) => exitHandlers.forEach(h => h(i)),
  }
}

function createFakeRepos(cwd = '/work', initialStatus: 'idle' | 'running' = 'idle') {
  const messages: Array<Record<string, unknown>> = []
  let status = initialStatus
  const repos = {
    conversations: {
      async findById(id: string) {
        return {
          id,
          cwd,
          userId: 'u1',
          cli: 'claude',
          platform: 'telegram',
          status,
          createdAt: 0,
          updatedAt: 0,
        }
      },
      async updateStatus(_id: string, nextStatus: 'idle' | 'running') {
        status = nextStatus
      },
    },
    messages: {
      async append(m: Record<string, unknown>) {
        messages.push(m)
        return m
      },
      async listByConversation() {
        return messages
      },
    },
    audit: {},
    memories: {},
  } as unknown as Repositories
  return { repos, messages, getStatus: () => status }
}

describe('SessionOrchestrator', () => {
  test('onMessage 懒启动 adapter（按 cwd）并喂入用户输入', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos('/proj')
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    const res = await orch.handler.onMessage('hi', CID)

    expect(res).toBe('') // 输出走聚合器流，不经返回值
    expect(fake.calls.start.length).toBe(1)
    expect(fake.calls.start[0]!.cwd).toBe('/proj')
    expect(fake.calls.start[0]!.conversationId).toBe(CID)
    expect(fake.calls.start[0]!.systemLanguageHint).toContain('中文')
    expect(fake.calls.sendUserInput).toEqual(['hi'])

    await orch.destroy()
    agg.destroy()
  })

  test('复用同会话 adapter：第二条消息不重启', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    await orch.handler.onMessage('one', CID)
    await orch.handler.onMessage('two', CID)

    expect(fake.calls.start.length).toBe(1)
    expect(fake.calls.sendUserInput).toEqual(['one', 'two'])

    await orch.destroy()
    agg.destroy()
  })

  test('adapter 审批请求 → 广播 ApprovalRequested（补 conversationId）', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    const seen: unknown[] = []
    bus.on('ApprovalRequested', p => seen.push(p))

    await orch.handler.onMessage('do', CID)
    fake.emitApproval({ approvalId: 'a1', command: 'Bash', detail: '{"cmd":"ls"}' })

    expect(seen).toEqual([{ conversationId: CID, approvalId: 'a1', command: 'Bash', detail: '{"cmd":"ls"}' }])

    await orch.destroy()
    agg.destroy()
  })

  test('ApprovalApproved/Rejected → adapter.resolveApproval；Reject 中断并停止 adapter', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    await orch.handler.onMessage('do', CID)
    bus.emit('ApprovalApproved', { conversationId: CID, approvalId: 'a1', operator: 'u1' })
    bus.emit('ApprovalRejected', { conversationId: CID, approvalId: 'a2', operator: 'u1' })

    expect(fake.calls.resolveApproval).toEqual([
      ['a1', 'approve'],
      ['a2', 'reject'],
    ])
    expect(fake.calls.interrupt).toBe(1)
    expect(fake.calls.callOrder).toEqual(['resolve:approve', 'interrupt', 'resolve:reject'])
    await tick()
    expect(fake.calls.stop).toBe(1)

    await orch.destroy()
    agg.destroy()
  })

  test('审批决议幂等：重复回调只处理第一次', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    await orch.handler.onMessage('do', CID)
    bus.emit('ApprovalApproved', { conversationId: CID, approvalId: 'a1', operator: 'u1' })
    bus.emit('ApprovalApproved', { conversationId: CID, approvalId: 'a1', operator: 'u1' })
    bus.emit('ApprovalRejected', { conversationId: CID, approvalId: 'a1', operator: 'u1' })

    expect(fake.calls.resolveApproval).toEqual([['a1', 'approve']])
    expect(fake.calls.interrupt).toBe(0)

    await orch.destroy()
    agg.destroy()
  })

  test('ApprovalRejected 后下一条消息重启 adapter 并带最近上下文', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos, messages } = createFakeRepos()
    messages.push({
      id: 'docx',
      conversationId: CID,
      role: 'user',
      content:
        '[File preprocessing context]\nCurrent message file/attachment context:\n- kind=document, name=report.docx, local_path=D:/media/report.docx\n  content_status: saved_only_lazy_load',
      createdAt: 1,
    })
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    await orch.handler.onMessage('read file', CID)
    bus.emit('ApprovalRejected', { conversationId: CID, approvalId: 'a1', operator: 'u1' })
    await tick()
    await orch.handler.onMessage('直接告诉我最新文件内容', CID)

    expect(fake.calls.stop).toBe(1)
    expect(fake.calls.start.length).toBe(2)
    expect(fake.calls.sendUserInput[1]).toContain('local_path=D:/media/report.docx')
    expect(fake.calls.sendUserInput[1]).toContain('content_status: saved_only_lazy_load')
    expect(fake.calls.sendUserInput[1]).toContain('[本次用户输入]\n直接告诉我最新文件内容')

    await orch.destroy()
    agg.destroy()
  })

  test('语言偏好注入 adapter.start', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      getUserLanguage: () => 'en',
    })

    await orch.handler.onMessage('hi', CID)

    expect(fake.calls.start[0]!.systemLanguageHint).toContain('English')

    await orch.destroy()
    agg.destroy()
  })

  test('AGENT_DESCRIPTION 注入 system hint', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      agentDescription: '负责远程管理个人 VPS 上的 AI CLI 会话。',
    })

    await orch.handler.onMessage('hi', CID)

    expect(fake.calls.start[0]!.systemLanguageHint).toContain('[Agent 职责定位]')
    expect(fake.calls.start[0]!.systemLanguageHint).toContain('负责远程管理个人 VPS 上的 AI CLI 会话。')

    await orch.destroy()
    agg.destroy()
  })

  test('全局记忆上下文注入 adapter.start', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      getSystemMemoryHint: () => '[长期记忆 · 供参考]\n- 事实：所有软件都放在 softs 文件夹\n---',
    })

    await orch.handler.onMessage('hi', CID)

    expect(fake.calls.start[0]!.systemLanguageHint).toContain('所有软件都放在 softs 文件夹')

    await orch.destroy()
    agg.destroy()
  })

  test('debugMessageFlow 默认关闭时不打印链路日志', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const diagnostics: Array<{ event: string; data: Record<string, unknown> }> = []
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      messageFlowLogger: (event, data) => diagnostics.push({ event, data }),
    })

    await orch.handler.onMessage('hi', CID)

    expect(diagnostics).toEqual([])

    await orch.destroy()
    agg.destroy()
  })

  test('debugMessageFlow 开启后打印 adapterStarted 和 sendUserInput', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos('/proj')
    const diagnostics: Array<{ event: string; data: Record<string, unknown> }> = []
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      debugMessageFlow: true,
      messageFlowLogger: (event, data) => diagnostics.push({ event, data }),
    })

    await orch.handler.onMessage('hi', CID)

    expect(diagnostics.map(d => d.event)).toContain('adapterStarted')
    expect(diagnostics.map(d => d.event)).toContain('sendUserInput')
    expect(diagnostics.find(d => d.event === 'adapterStarted')?.data).toMatchObject({
      conversationId: CID,
      userId: 'u1',
      cwd: '/proj',
    })
    expect(diagnostics.find(d => d.event === 'sendUserInput')?.data).toMatchObject({
      conversationId: CID,
      userId: 'u1',
      originalTextChars: 2,
      inputChars: 2,
      recentContextIncluded: false,
    })

    await orch.destroy()
    agg.destroy()
  })

  test('debugMessageFlow 开启后打印完整消息链路内容', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos('/proj')
    const logs: Array<{ event: string; data: Record<string, unknown> }> = []
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      getSystemMemoryHint: () => '[长期记忆 · 供参考]\n- 事实：softs 目录\n---',
      getRelevantMemoryHint: () => '[相关长期记忆 · 语义召回]\n- 情节：PM2 重启\n---',
      debugMessageFlow: true,
      messageFlowLogger: (event, data) => logs.push({ event, data }),
    })

    await orch.handler.onMessage('PM2 怎么重启？', CID)
    fake.emitOutput({ kind: 'text', text: '使用 pm2 restart ai-cli-hub', final: true })
    await sleep(0)

    expect(logs.map(d => d.event)).toContain('adapterStarted')
    expect(logs.map(d => d.event)).toContain('sendUserInput')
    expect(logs.map(d => d.event)).toContain('adapterOutput')
    expect(logs.map(d => d.event)).toContain('assistantMessagePersisted')
    expect(logs.find(d => d.event === 'adapterStarted')?.data).toMatchObject({
      systemMemoryHint: '[长期记忆 · 供参考]\n- 事实：softs 目录\n---',
    })
    expect(logs.find(d => d.event === 'sendUserInput')?.data).toMatchObject({
      originalText: 'PM2 怎么重启？',
    })
    expect(String(logs.find(d => d.event === 'sendUserInput')?.data.input)).toContain('[相关长期记忆 · 语义召回]')
    expect(logs.find(d => d.event === 'adapterOutput')?.data).toMatchObject({
      text: '使用 pm2 restart ai-cli-hub',
      final: true,
    })

    await orch.destroy()
    agg.destroy()
  })

  test('debugMessageFlow 开启后一轮超时无 output/approval/result 会打印 turnTimeout', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const diagnostics: Array<{ event: string; data: Record<string, unknown> }> = []
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      debugMessageFlow: true,
      messageFlowLogger: (event, data) => diagnostics.push({ event, data }),
      turnTimeoutMs: 5,
    })

    await orch.handler.onMessage('hi', CID)
    await sleep(20)

    expect(diagnostics.find(d => d.event === 'turnTimeout')?.data).toMatchObject({
      conversationId: CID,
      userId: 'u1',
      timeoutMs: 5,
      inputChars: 2,
    })

    await orch.destroy()
    agg.destroy()
  })

  test('记忆召回失败只发 ErrorOccurred，不阻塞 adapter 启动', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const errors: Array<{ scope: string }> = []
    bus.on('ErrorOccurred', p => errors.push(p))
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      getSystemMemoryHint: () => {
        throw new Error('memory unavailable')
      },
    })

    await orch.handler.onMessage('hi', CID)

    expect(fake.calls.start.length).toBe(1)
    expect(errors.some(e => e.scope === 'orchestrator:memoryRecall')).toBe(true)

    await orch.destroy()
    agg.destroy()
  })

  test('相关长期记忆按当前输入前缀注入 user input', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      getRelevantMemoryHint: query =>
        query.includes('PM2') ? '[相关长期记忆 · 语义召回]\n- 情节：PM2 部署已跑通\n---' : '',
    })

    await orch.handler.onMessage('PM2 怎么重启？', CID)

    expect(fake.calls.sendUserInput[0]).toContain('[相关长期记忆 · 语义召回]')
    expect(fake.calls.sendUserInput[0]).toContain('PM2 部署已跑通')
    expect(fake.calls.sendUserInput[0]).toContain('[本次用户输入]\nPM2 怎么重启？')

    await orch.destroy()
    agg.destroy()
  })

  test('支持隐藏上下文的 adapter 不把最近上下文和相关记忆拼进用户可见输入', async () => {
    const fake = createFakeAdapter({ contextInjection: true })
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos, messages } = createFakeRepos()
    messages.push(
      {
        id: 'old',
        conversationId: CID,
        role: 'user',
        content: 'old question',
        createdAt: 1,
      },
      {
        id: 'current',
        conversationId: CID,
        role: 'user',
        content: 'PM2 怎么重启？',
        createdAt: 2,
      },
    )
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      getRelevantMemoryHint: () => '[相关长期记忆 · 语义召回]\n- 情节：PM2 部署已跑通\n---',
    })

    await orch.handler.onMessage('PM2 怎么重启？', CID)

    expect(fake.calls.sendUserInput).toEqual(['PM2 怎么重启？'])
    expect(fake.calls.sendContext).toHaveLength(1)
    expect(fake.calls.sendContext[0]).toContain('[最近对话上下文 · 供延续当前会话]')
    expect(fake.calls.sendContext[0]).toContain('old question')
    expect(fake.calls.sendContext[0]).toContain('[相关长期记忆 · 语义召回]')
    expect(fake.calls.sendContext[0]).not.toContain('[本次用户输入]')

    await orch.destroy()
    agg.destroy()
  })

  test('低信息量问候不触发相关长期记忆召回', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    let recallCalls = 0
    const logs: Array<{ event: string; data: Record<string, unknown> }> = []
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      getRelevantMemoryHint: () => {
        recallCalls++
        return '[相关长期记忆 · 语义召回]\n- 情节：不应出现\n---'
      },
      debugMessageFlow: true,
      messageFlowLogger: (event, data) => logs.push({ event, data }),
    })

    await orch.handler.onMessage('hello', CID)

    expect(recallCalls).toBe(0)
    expect(fake.calls.sendUserInput).toEqual(['hello'])
    expect(logs.find(d => d.event === 'relevantMemoryHintResolved')?.data).toMatchObject({
      query: 'hello',
      included: false,
      skipped: true,
      reason: 'lowSignalQuery',
    })

    await orch.destroy()
    agg.destroy()
  })

  test('相关记忆召回失败只发 ErrorOccurred，不阻塞用户输入', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const errors: Array<{ scope: string }> = []
    bus.on('ErrorOccurred', p => errors.push(p))
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      getRelevantMemoryHint: () => {
        throw new Error('embedding unavailable')
      },
    })

    await orch.handler.onMessage('PM2 怎么重启？', CID)

    expect(fake.calls.sendUserInput).toEqual(['PM2 怎么重启？'])
    expect(errors.some(e => e.scope === 'orchestrator:semanticMemoryRecall')).toBe(true)

    await orch.destroy()
    agg.destroy()
  })

  test('SessionClosed → stop 并清理 adapter', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    await orch.handler.onMessage('one', CID)
    bus.emit('SessionClosed', { conversationId: CID, reason: 'user' })
    await tick()
    await orch.handler.onMessage('two', CID)

    expect(fake.calls.stop).toBe(1)
    expect(fake.calls.start.length).toBe(2)

    await orch.destroy()
    agg.destroy()
  })

  test('adapter 空闲超时 → stop 并把会话状态标回 idle', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos, getStatus } = createFakeRepos('/work', 'running')
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      idleTimeoutMs: 5,
    })

    await orch.handler.onMessage('one', CID)
    await sleep(25)

    expect(fake.calls.stop).toBe(1)
    expect(getStatus()).toBe('idle')

    await orch.destroy()
    agg.destroy()
  })

  test('adapter 异常退出 → 清理本会话并把非关闭状态标回 idle', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos, getStatus } = createFakeRepos('/work', 'running')
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    await orch.handler.onMessage('one', CID)
    fake.emitExit({ code: 1, reason: 'crash' })
    await tick()
    await orch.handler.onMessage('two', CID)

    expect(getStatus()).toBe('idle')
    expect(fake.calls.start.length).toBe(2)

    await orch.destroy()
    agg.destroy()
  })

  test('UserLanguageChanged → 停止该用户 adapter，下条消息按新语言重启', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    let lang: 'zh' | 'en' = 'zh'
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      getUserLanguage: () => lang,
    })

    await orch.handler.onMessage('one', CID)
    expect(fake.calls.start[0]!.systemLanguageHint).toContain('中文')

    lang = 'en'
    bus.emit('UserLanguageChanged', { userId: 'u1', language: 'en' })
    await tick()
    await orch.handler.onMessage('two', CID)

    expect(fake.calls.stop).toBe(1)
    expect(fake.calls.start.length).toBe(2)
    expect(fake.calls.start[1]!.systemLanguageHint).toContain('English')

    await orch.destroy()
    agg.destroy()
  })

  test('MemoryUpdated by operator → 停止该用户 adapter，下条消息重新注入最新记忆', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    let memoryHint = '[长期记忆 · 供参考]\n- 事实：旧记忆\n---'
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      getSystemMemoryHint: () => memoryHint,
    })

    await orch.handler.onMessage('one', CID)
    expect(fake.calls.start[0]!.systemLanguageHint).toContain('旧记忆')

    memoryHint = '[长期记忆 · 供参考]\n- 事实：新记忆\n---'
    bus.emit('MemoryUpdated', {
      conversationId: null,
      namespace: 'global',
      memoryType: 'semantic',
      memoryId: 'm1',
      operatorUserId: 'u1',
    })
    await tick()
    await orch.handler.onMessage('two', CID)

    expect(fake.calls.stop).toBe(1)
    expect(fake.calls.start.length).toBe(2)
    expect(fake.calls.start[1]!.systemLanguageHint).toContain('新记忆')

    await orch.destroy()
    agg.destroy()
  })

  test('adapter 刚启动时把当前会话最近 10 条历史放进 user input，不重复当前消息', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos, messages } = createFakeRepos()
    for (let i = 1; i <= 12; i++) {
      messages.push({
        id: `m${i}`,
        conversationId: CID,
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `history-${i}`,
        createdAt: i,
      })
    }
    messages.push({
      id: 'current',
      conversationId: CID,
      role: 'user',
      content: 'current question',
      createdAt: 13,
    })
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    await orch.handler.onMessage('current question', CID)
    await orch.handler.onMessage('follow up', CID)

    const firstInput = fake.calls.sendUserInput[0]!
    expect(firstInput).toContain('[最近对话上下文 · 供延续当前会话]')
    expect(firstInput).not.toMatch(/：history-1(\n|$)/)
    expect(firstInput).not.toMatch(/：history-2(\n|$)/)
    expect(firstInput).toContain('history-3')
    expect(firstInput).toContain('history-12')
    expect(firstInput).toContain('[本次用户输入]\ncurrent question')
    expect(firstInput.match(/current question/g)?.length).toBe(1)
    expect(fake.calls.sendUserInput[1]).toBe('follow up')

    await orch.destroy()
    agg.destroy()
  })

  test('最近上下文条数和单条长度可配置，长消息保留尾部', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos, messages } = createFakeRepos()
    messages.push(
      {
        id: 'old',
        conversationId: CID,
        role: 'user',
        content: 'old-message',
        createdAt: 1,
      },
      {
        id: 'long',
        conversationId: CID,
        role: 'assistant',
        content: 'prefix-should-be-dropped-final-answer-kept',
        createdAt: 2,
      },
      {
        id: 'new',
        conversationId: CID,
        role: 'user',
        content: 'new-message',
        createdAt: 3,
      },
      {
        id: 'current',
        conversationId: CID,
        role: 'user',
        content: 'current question',
        createdAt: 4,
      },
    )
    const orch = createSessionOrchestrator({
      bus,
      repos,
      aggregator: agg,
      adapterFactory: () => fake.adapter,
      recentContextLimit: 2,
      recentContextMessageMaxChars: 20,
    })

    await orch.handler.onMessage('current question', CID)

    const firstInput = fake.calls.sendUserInput[0]!
    expect(firstInput).not.toContain('old-message')
    expect(firstInput).not.toContain('prefix-should-be-dropped')
    expect(firstInput).toContain('...final-answer-kept')
    expect(firstInput).toContain('new-message')

    await orch.destroy()
    agg.destroy()
  })

  test('MemoryUpdated without operator 不停止运行中 adapter', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    await orch.handler.onMessage('one', CID)
    bus.emit('MemoryUpdated', {
      conversationId: null,
      namespace: 'global',
      memoryType: 'semantic',
      memoryId: 'env.os',
    })
    await tick()
    await orch.handler.onMessage('two', CID)

    expect(fake.calls.stop).toBe(0)
    expect(fake.calls.start.length).toBe(1)

    await orch.destroy()
    agg.destroy()
  })

  test('destroy 等待 adapter.stop 完成后才返回', async () => {
    let releaseStop!: () => void
    let stopped = false
    const stopGate = new Promise<void>(resolve => {
      releaseStop = () => {
        stopped = true
        resolve()
      }
    })
    const fake = createFakeAdapter({ onStop: () => stopGate })
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos } = createFakeRepos()
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    await orch.handler.onMessage('one', CID)
    const destroying = orch.destroy()
    await tick()

    expect(fake.calls.stop).toBe(1)
    expect(stopped).toBe(false)

    releaseStop()
    await destroying

    expect(stopped).toBe(true)
    agg.destroy()
  })

  test('输出累计：final 冲刷发 MessageGenerated 并落一条 assistant 消息', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const { repos, messages } = createFakeRepos()
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    const gen: Array<{ content: string; final: boolean }> = []
    bus.on('MessageGenerated', p => gen.push(p))

    await orch.handler.onMessage('q', CID)
    fake.emitOutput({ kind: 'text', text: 'Hello', final: false })
    fake.emitOutput({ kind: 'text', text: ' world', final: false })
    fake.emitOutput({ kind: 'text', text: '', final: true })
    await tick()

    // 定稿 MessageGenerated（累计全文）
    expect(gen.some(g => g.final && g.content === 'Hello world')).toBe(true)
    // 助手消息落库一条，内容为本轮全文
    const asst = messages.filter(m => m.role === 'assistant')
    expect(asst.length).toBe(1)
    expect(asst[0]!.content).toBe('Hello world')

    await orch.destroy()
    agg.destroy()
  })

  test('会话不存在 → 报 ErrorOccurred，不启动 adapter', async () => {
    const fake = createFakeAdapter()
    const bus = createEventBus()
    const agg = createMessageAggregator(bus)
    const repos = {
      conversations: {
        async findById() {
          return null
        },
      },
      messages: {
        async append(m: unknown) {
          return m
        },
      },
      audit: {},
      memories: {},
    } as unknown as Repositories
    const orch = createSessionOrchestrator({ bus, repos, aggregator: agg, adapterFactory: () => fake.adapter })

    const errors: Array<{ scope: string }> = []
    bus.on('ErrorOccurred', p => errors.push(p))

    await expect(orch.handler.onMessage('x', CID)).rejects.toThrow('CLI adapter 启动失败')

    expect(fake.calls.start.length).toBe(0)
    expect(errors.some(e => e.scope === 'orchestrator:ensureAdapter')).toBe(true)

    await orch.destroy()
    agg.destroy()
  })
})
