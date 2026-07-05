import { describe, expect, test } from 'bun:test'
import { createEventBus } from './event'
import { createMessageAggregator } from './core'
import { createSessionOrchestrator } from './orchestrator'
import type { ConversationId } from './shared'
import type { CLIAdapter, OutputDelta, ApprovalRequest, ExitInfo, SpawnOptions, ApprovalAction } from './cli'
import type { Repositories } from './repository'

const CID = 'conv-1' as ConversationId

const tick = () => new Promise(r => setTimeout(r, 0))

/** 假 adapter：记录调用，允许测试手动触发 output/approval/exit。 */
function createFakeAdapter() {
  const outputHandlers: Array<(d: OutputDelta) => void> = []
  const approvalHandlers: Array<(r: ApprovalRequest) => void> = []
  const exitHandlers: Array<(i: ExitInfo) => void> = []
  const calls = {
    start: [] as SpawnOptions[],
    sendUserInput: [] as string[],
    resolveApproval: [] as Array<[string, ApprovalAction]>,
    stop: 0,
  }
  const adapter: CLIAdapter = {
    cliType: 'claude',
    async start(opts) {
      calls.start.push(opts)
    },
    async stop() {
      calls.stop++
    },
    interrupt() {},
    sendUserInput(t) {
      calls.sendUserInput.push(t)
    },
    resolveApproval(id, d) {
      calls.resolveApproval.push([id, d])
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
  return {
    adapter,
    calls,
    emitOutput: (d: OutputDelta) => outputHandlers.forEach(h => h(d)),
    emitApproval: (r: ApprovalRequest) => approvalHandlers.forEach(h => h(r)),
    emitExit: (i: ExitInfo) => exitHandlers.forEach(h => h(i)),
  }
}

function createFakeRepos(cwd = '/work') {
  const messages: Array<Record<string, unknown>> = []
  const repos = {
    conversations: {
      async findById(id: string) {
        return {
          id,
          cwd,
          userId: 'u1',
          cli: 'claude',
          platform: 'telegram',
          status: 'idle',
          createdAt: 0,
          updatedAt: 0,
        }
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
  return { repos, messages }
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
    expect(fake.calls.sendUserInput).toEqual(['hi'])

    orch.destroy()
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

    orch.destroy()
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

    orch.destroy()
    agg.destroy()
  })

  test('ApprovalApproved/Rejected → adapter.resolveApproval', async () => {
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

    orch.destroy()
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

    orch.destroy()
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

    const res = await orch.handler.onMessage('x', CID)

    expect(res).toBe('')
    expect(fake.calls.start.length).toBe(0)
    expect(errors.some(e => e.scope === 'orchestrator:ensureAdapter')).toBe(true)

    orch.destroy()
    agg.destroy()
  })
})
