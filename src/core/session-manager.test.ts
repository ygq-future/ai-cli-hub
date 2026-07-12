import { describe, expect, test } from 'bun:test'
import type {
  Conversation,
  NewConversation,
  ConversationId,
  AuditLog,
  NewAuditLog,
  Memory,
  NewMemory,
} from '../repository'
import type { EventBus } from '../event'
import { createCommandRouter } from './commands'
import { createSessionManager } from './session-manager'
import { createMessageRouter, type MessageHandler } from './message-router'

// ---- In-memory mock repositories ----
function createMockRepos() {
  const conversations: Record<string, Conversation> = {}
  const messages: Array<Record<string, unknown>> = []
  const auditLogs: AuditLog[] = []
  const memories: Memory[] = []

  function findActive(platform: string, userId: string): Conversation | null {
    const latest =
      Object.values(conversations)
        .filter(c => c.platform === platform && c.userId === userId)
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0] ?? null
    if (latest?.status === 'closed' || latest?.status === 'closing') return null
    return latest
  }

  // messages is referenced by the arrow functions below
  void messages

  return {
    conversations: {
      async create(c: NewConversation) {
        const conv = {
          id: c.id as string,
          platform: c.platform as string,
          userId: c.userId as string,
          cli: c.cli as string,
          cwd: c.cwd as string,
          status: c.status as string,
          createdAt: c.createdAt as number,
          updatedAt: c.updatedAt as number,
        } as Conversation
        conversations[conv.id] = conv
        return conv
      },
      async findActive(platform: string, userId: string) {
        return findActive(platform, userId)
      },
      async findLatestOpenByUser(platform: string, userId: string) {
        return (
          Object.values(conversations)
            .filter(
              c => c.platform === platform && c.userId === userId && c.status !== 'closed' && c.status !== 'closing',
            )
            .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0] ?? null
        )
      },
      async findLatestByUser(platform: string, userId: string) {
        return (
          Object.values(conversations)
            .filter(c => c.platform === platform && c.userId === userId)
            .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0] ?? null
        )
      },
      async findById(id: string) {
        return conversations[id] ?? null
      },
      async listOpenByUser(platform: string, userId: string) {
        return Object.values(conversations)
          .filter(c => c.platform === platform && c.userId === userId && c.status !== 'closed')
          .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      },
      async listRecentByUser(platform: string, userId: string, limit: number) {
        return Object.values(conversations)
          .filter(c => c.platform === platform && c.userId === userId)
          .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
          .slice(0, limit)
      },
      async updateStatus(id: string, status: string) {
        const c = conversations[id]
        if (c) {
          conversations[id] = { ...c, status: status as Conversation['status'], updatedAt: Date.now() }
        }
      },
      async reconcileRuntimeStatuses() {},
      async listStaleIdle(beforeTs: number) {
        return Object.values(conversations).filter(c => c.status === 'idle' && c.updatedAt < beforeTs)
      },
    },
    messages: {
      async append(m: Record<string, unknown>) {
        messages.push(m)
        return m
      },
      async listByConversation(id: ConversationId) {
        return messages.filter(m => m.conversationId === id)
      },
    },
    audit: {
      async record(a: NewAuditLog) {
        auditLogs.push(a as AuditLog)
      },
      async listByConversation(id: ConversationId) {
        return auditLogs.filter(a => a.conversationId === id)
      },
    },
    memories: {
      async insert(m: NewMemory) {
        const memory = m as Memory
        memories.push(memory)
        return memory
      },
      async upsertByTag(
        _namespace: string,
        _tag: string,
        m: Omit<NewMemory, 'id' | 'namespace' | 'tag' | 'createdAt'>,
      ) {
        const memory = {
          ...m,
          id: crypto.randomUUID(),
          namespace: 'global',
          tag: _tag,
          createdAt: Date.now(),
        } as Memory
        memories.push(memory)
        return memory
      },
      async listGlobal(namespace: string) {
        return memories.filter(m => m.namespace === namespace && m.conversationId === null)
      },
      async findById(id: string) {
        return memories.find(m => m.id === id) ?? null
      },
      async searchByKeyword() {
        return []
      },
      async searchByVector() {
        return []
      },
      async touch() {},
      async delete(id: string) {
        const idx = memories.findIndex(m => m.id === id)
        if (idx >= 0) memories.splice(idx, 1)
      },
    },
  } as unknown as Parameters<typeof createSessionManager>[1]
}

interface MockEventBus {
  on: EventBus['on']
  once: EventBus['once']
  emit: EventBus['emit']
}

function createMockBus(): MockEventBus {
  const handlers = new Map<string, Array<(payload: unknown) => void>>()
  return {
    on: ((event: string, handler: (p: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event)!.push(handler)
      return () => {
        const list = handlers.get(event)
        if (list) {
          const idx = list.indexOf(handler)
          if (idx >= 0) list.splice(idx, 1)
        }
      }
    }) as EventBus['on'],
    once: ((event: string, handler: (p: unknown) => void) => {
      const wrapper = (p: unknown) => {
        handler(p)
        // remove after first call
        const list = handlers.get(event)
        if (list) {
          const idx = list.indexOf(wrapper)
          if (idx >= 0) list.splice(idx, 1)
        }
      }
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event)!.push(wrapper)
      return () => {
        const list = handlers.get(event)
        if (list) {
          const idx = list.indexOf(wrapper)
          if (idx >= 0) list.splice(idx, 1)
        }
      }
    }) as EventBus['once'],
    emit: ((event: string, payload: unknown) => {
      const list = handlers.get(event)
      if (list) {
        for (const h of [...list]) {
          try {
            h(payload)
          } catch {
            /* per-subscriber isolation */
          }
        }
      }
    }) as EventBus['emit'],
  }
}

describe('SessionManager', () => {
  test('findOrCreate 新建会话并发射 SessionCreated', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const events: unknown[] = []
    const mapped: unknown[] = []
    bus.on('SessionCreated', p => events.push(p))
    bus.on('SessionMapped', p => mapped.push(p))

    const cid1 = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hello',
    })
    expect(cid1).toBeTruthy()
    expect(events.length).toBe(1)
    expect((events[0] as Record<string, unknown>).userId).toBe('u1')

    const cid2 = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'world',
    })
    expect(cid2).toBe(cid1)
    expect(events.length).toBe(1)
    expect(mapped).toEqual([{ conversationId: cid1, platform: 'telegram', userId: 'u1' }])
  })

  test('普通消息复用用户最新未关闭会话，不因 cwd 目标丢失新建', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const targetChanges: unknown[] = []
    bus.on('UserTargetChanged', p => targetChanges.push(p))

    const cid1 = await sm.findOrCreate({ userId: 'u1', platform: 'telegram', cli: 'claude', cwd: '/a', text: 'hi' })
    const cid2 = await sm.findOrCreate({ userId: 'u1', platform: 'telegram', cli: 'claude', cwd: '/b', text: 'hi' })
    expect(cid2).toBe(cid1)
    expect(targetChanges).toEqual([{ userId: 'u1', platform: 'telegram', cli: 'claude', cwd: '/a' }])
  })

  test('相同 userId 的不同平台会话相互隔离，/new 不会关闭另一平台', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const telegram = await sm.findOrCreate({
      userId: 'same-id',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/tg',
      text: 'hi',
    })
    const qq = await sm.findOrCreate({ userId: 'same-id', platform: 'qq', cli: 'opencode', cwd: '/qq', text: 'hi' })

    await sm.forceNew({ userId: 'same-id', platform: 'telegram', cli: 'claude', cwd: '/next', text: '/new' })

    expect((await repos.conversations.findById(telegram))?.status).toBe('closed')
    expect((await repos.conversations.findById(qq))?.status).toBe('idle')
    expect(await repos.conversations.findLatestOpenByUser('qq', 'same-id')).toMatchObject({ id: qq, cli: 'opencode' })
  })

  test('forceNew 关闭旧活跃会话再新建', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const closed: unknown[] = []
    bus.on('SessionClosed', p => closed.push(p))

    const cid1 = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hi',
    })
    const cid2 = await sm.forceNew({ userId: 'u1', platform: 'telegram', cli: 'claude', cwd: '/project', text: '/new' })

    expect(cid1).not.toBe(cid2)
    expect((await repos.conversations.findById(cid1))?.status).toBe('closed')
    expect((await repos.conversations.findById(cid2))?.status).toBe('idle')
    expect(closed).toEqual([{ conversationId: cid1, reason: 'user' }])
  })

  test('forceNew 新建前兜底关闭该用户所有历史未 closed 会话', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const closed: unknown[] = []
    bus.on('SessionClosed', p => closed.push(p))

    const staleA = await repos.conversations.create({
      id: 'stale-a',
      platform: 'telegram',
      userId: 'u1',
      cli: 'claude',
      cwd: '/a',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    })
    const staleB = await repos.conversations.create({
      id: 'stale-b',
      platform: 'telegram',
      userId: 'u1',
      cli: 'claude',
      cwd: '/b',
      status: 'running',
      createdAt: 2,
      updatedAt: 2,
    })

    const cid = await sm.forceNew({ userId: 'u1', platform: 'telegram', cli: 'claude', cwd: '/c', text: '/new' })

    expect((await repos.conversations.findById(staleA.id as ConversationId))?.status).toBe('closed')
    expect((await repos.conversations.findById(staleB.id as ConversationId))?.status).toBe('closed')
    expect((await repos.conversations.findById(cid))?.status).toBe('idle')
    expect(closed).toEqual([
      { conversationId: 'stale-b', reason: 'user' },
      { conversationId: 'stale-a', reason: 'user' },
    ])
  })

  test('findOrCreate 新建前兜底关闭卡在 closing 的历史会话', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)

    await repos.conversations.create({
      id: 'stale-closing',
      platform: 'telegram',
      userId: 'u1',
      cli: 'claude',
      cwd: '/old',
      status: 'closing',
      createdAt: 1,
      updatedAt: 1,
    })

    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/new',
      text: 'hello',
    })

    expect(cid).not.toBe('stale-closing')
    expect((await repos.conversations.findById('stale-closing' as ConversationId))?.status).toBe('closed')
    expect((await repos.conversations.findById(cid))?.status).toBe('idle')
  })

  test('findOrCreate 不在最新会话 closed 后翻出更旧 idle，会新建会话', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)

    const oldIdle = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'old',
    })
    await new Promise(r => setTimeout(r, 2))
    const latest = await sm.forceNew({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: '/new',
    })
    await sm.close(latest, 'user')

    const afterClose = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hello',
    })

    expect(afterClose).not.toBe(oldIdle)
    expect(afterClose).not.toBe(latest)
  })

  test('findOrCreate 无 open 会话时用最近 closed 会话恢复 cli，但保留当前 cwd target', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const targetChanges: unknown[] = []
    bus.on('UserTargetChanged', p => targetChanges.push(p))

    const opencode = await sm.forceNew({
      userId: 'u1',
      platform: 'telegram',
      cli: 'opencode',
      cwd: '/opencode-project',
      text: '/new opencode',
      cliExplicit: true,
      cwdExplicit: true,
    })
    await sm.close(opencode, 'user')

    const restored = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/default',
      text: 'hello after restart',
    })

    const conv = await repos.conversations.findById(restored)
    expect(conv?.cli).toBe('opencode')
    expect(conv?.cwd).toBe('/default')
    expect(targetChanges.at(-1)).toEqual({ userId: 'u1', platform: 'telegram', cli: 'opencode', cwd: '/default' })
  })

  test('close 将会话从 running 转 closed', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)

    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hi',
    })
    await sm.transition(cid, 'START')
    await sm.transition(cid, 'ADAPTER_READY')
    expect((await repos.conversations.findById(cid))?.status).toBe('running')

    await sm.close(cid, 'user')
    expect((await repos.conversations.findById(cid))?.status).toBe('closed')
  })

  test('close 幂等', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hi',
    })
    await sm.close(cid, 'user')
    await expect(sm.close(cid, 'user')).resolves.toBeUndefined()
    expect((await repos.conversations.findById(cid))?.status).toBe('closed')
  })

  test('非法 transition 抛错', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hi',
    })
    await expect(sm.transition(cid, 'ADAPTER_READY')).rejects.toThrow('SessionMachine')
  })

  test('getStatus 返回正确状态或 null', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)

    expect(await sm.getStatus('nonexistent' as ConversationId)).toBeNull()
    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hi',
    })
    expect(await sm.getStatus(cid)).toBe('idle')
    await sm.transition(cid, 'START')
    expect(await sm.getStatus(cid)).toBe('starting')
  })

  test('SessionClosed 事件发射', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)

    const events: unknown[] = []
    bus.on('SessionClosed', p => events.push(p))

    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hi',
    })
    await sm.close(cid, 'user')

    expect(events.length).toBe(1)
    expect((events[0] as Record<string, unknown>).conversationId).toBe(cid)
    expect((events[0] as Record<string, unknown>).reason).toBe('user')
  })
})

describe('MessageRouter with MockHandler', () => {
  test('收到 MessageReceived 后保存消息并发射 MessageGenerated', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)

    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hello',
    })

    const handler: MessageHandler = {
      async onMessage(text: string) {
        return `Echo: ${text}`
      },
    }

    createMessageRouter(bus as unknown as EventBus, repos, sm, undefined, handler)

    const generated: unknown[] = []
    bus.on('MessageGenerated', p => generated.push(p))

    // D13：MessageReceived 不含 conversationId；router 经 findOrCreate 解析同一会话
    // （mock findActive 返回上面预建的 (u1,claude,/project) 会话）。
    bus.emit('MessageReceived', {
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'Hello from test',
      ref: { platform: 'telegram' as const, chatId: 'c', nativeId: '1' },
    })

    await new Promise(r => setTimeout(r, 10))

    const msgs = await repos.messages.listByConversation(cid)
    expect(msgs.length).toBeGreaterThanOrEqual(2)
    expect(await sm.getStatus(cid)).toBe('running')
    const lastUserMsg = msgs[msgs.length - 2] as Record<string, unknown>
    const lastAsstMsg = msgs[msgs.length - 1] as Record<string, unknown>
    expect(lastUserMsg.role).toBe('user')
    expect(lastUserMsg.content).toBe('Hello from test')
    expect(lastAsstMsg.role).toBe('assistant')
    expect(lastAsstMsg.content).toBe('Echo: Hello from test')

    expect(generated.length).toBe(1)
    expect((generated[0] as Record<string, unknown>).content).toBe('Echo: Hello from test')
    expect((generated[0] as Record<string, unknown>).final).toBe(true)
  })

  test('自然语言记忆请求触发 MemorySummaryRequested，不进入 handler/SDK', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)

    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hello',
    })

    let handlerCalls = 0
    const handler: MessageHandler = {
      async onMessage(text: string) {
        handlerCalls++
        return `Echo: ${text}`
      },
    }
    createMessageRouter(bus as unknown as EventBus, repos, sm, undefined, handler, () => 'en')

    const requested: unknown[] = []
    const generated: unknown[] = []
    bus.on('MemorySummaryRequested', p => requested.push(p))
    bus.on('MessageGenerated', p => generated.push(p))

    bus.emit('MessageReceived', {
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: '没事,你记住在这个地方就行了',
      ref: { platform: 'telegram' as const, chatId: 'c', nativeId: '1' },
    })

    await new Promise(r => setTimeout(r, 10))

    const msgs = await repos.messages.listByConversation(cid)
    expect(handlerCalls).toBe(0)
    expect(await sm.getStatus(cid)).toBe('idle')
    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({
      conversationId: cid,
      userId: 'u1',
      language: 'en',
      reason: 'userRememberRequest',
      text: '没事,你记住在这个地方就行了',
    })
    expect(msgs.at(-2)).toMatchObject({ role: 'user', content: '没事,你记住在这个地方就行了' })
    expect(msgs.at(-1)).toMatchObject({
      role: 'assistant',
      content: '已收到，我会根据当前会话最近 10 条消息总结成长期记忆。',
    })
    expect(generated[0]).toMatchObject({
      conversationId: cid,
      content: '已收到，我会根据当前会话最近 10 条消息总结成长期记忆。',
      final: true,
    })
  })

  test('异常时发 ErrorOccurred', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)

    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hi',
    })
    void cid

    const failingHandler: MessageHandler = {
      async onMessage() {
        throw new Error('Mock failure')
      },
    }

    createMessageRouter(bus as unknown as EventBus, repos, sm, undefined, failingHandler)

    const errors: unknown[] = []
    bus.on('ErrorOccurred', p => errors.push(p))

    bus.emit('MessageReceived', {
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'trigger error',
      ref: { platform: 'telegram' as const, chatId: 'c', nativeId: '1' },
    })

    await new Promise(r => setTimeout(r, 10))

    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect((errors[0] as Record<string, unknown>).scope).toBe('router:MessageReceived')
    expect((errors[0] as Record<string, unknown>).message).toContain('Mock failure')
  })

  test('斜杠命令先走 CommandRouter：不保存消息、不调用 handler', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
      getUserLanguage: () => 'en',
    })

    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hi',
    })

    let handledByAdapter = false
    const handler: MessageHandler = {
      async onMessage() {
        handledByAdapter = true
        return 'should not happen'
      },
    }

    createMessageRouter(bus as unknown as EventBus, repos, sm, commandRouter, handler)

    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    bus.emit('MessageReceived', {
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: '/status',
      ref: { platform: 'telegram' as const, chatId: 'c', nativeId: '1' },
    })

    await new Promise(r => setTimeout(r, 10))

    const msgs = await repos.messages.listByConversation(cid)
    expect(msgs.length).toBe(0)
    expect(handledByAdapter).toBe(false)
    expect(replies.length).toBe(1)
    expect((replies[0] as Record<string, unknown>).content).toContain('Current session')
    expect((replies[0] as Record<string, unknown>).content).toContain('**Language**: `en`')
  })
})

describe('CommandRouter', () => {
  test('/cwd path 关闭当前会话并切换目标 cwd，不创建新会话', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
      resolveCwd: cwd => ({ ok: true, cwd }),
    })

    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: 'hi',
    })

    const targetChanges: unknown[] = []
    const replies: unknown[] = []
    bus.on('UserTargetChanged', p => targetChanges.push(p))
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/cwd /new',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    expect((await repos.conversations.findById(cid))?.status).toBe('closed')
    expect(targetChanges).toEqual([{ userId: 'u1', platform: 'telegram', cli: 'claude', cwd: '/new' }])
    expect(replies.length).toBe(1)
    expect((replies[0] as { content: string }).content).toContain('工作目录已切换')
  })

  test('/new 拒绝未接入 CLI', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
    })

    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/new codex /tmp',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    expect(replies.length).toBe(1)
    expect((replies[0] as { content: string }).content).toContain('暂不支持 CLI：codex')
  })

  test('/new 支持 opencode CLI', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
    })

    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/new opencode /tmp',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    expect(replies.length).toBe(1)
    expect((replies[0] as { content: string }).content).toContain('CLI: opencode')
    expect((await repos.conversations.listRecentByUser('telegram', 'u1', 1))[0]?.cli).toBe('opencode')
  })

  test('/new 无参数时用最近 closed 会话恢复 cli，但保留当前 cwd target', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
    })
    const old = await sm.forceNew({
      userId: 'u1',
      platform: 'telegram',
      cli: 'opencode',
      cwd: '/opencode-project',
      text: '/new opencode',
      cliExplicit: true,
      cwdExplicit: true,
    })
    await sm.close(old, 'user')
    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/default',
      text: '/new',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    const created = (await repos.conversations.listRecentByUser('telegram', 'u1', 10)).find(c => c.status === 'idle')
    expect(created?.cli).toBe('opencode')
    expect(created?.cwd).toBe('/default')
    expect((replies[0] as { content: string }).content).toContain('CLI: opencode')
    expect((replies[0] as { content: string }).content).toContain('CWD: /default')
  })

  test('/new 只指定 cwd 时沿用最近 closed 会话 cli，但使用新 cwd', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
      resolveCwd: cwd => ({ ok: true, cwd }),
    })
    const old = await sm.forceNew({
      userId: 'u1',
      platform: 'telegram',
      cli: 'opencode',
      cwd: '/opencode-project',
      text: '/new opencode',
      cliExplicit: true,
      cwdExplicit: true,
    })
    await sm.close(old, 'user')

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/default',
      text: '/new /next-project',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    const created = (await repos.conversations.listRecentByUser('telegram', 'u1', 10)).find(c => c.status === 'idle')
    expect(created?.cli).toBe('opencode')
    expect(created?.cwd).toBe('/next-project')
  })

  test('/new 显式指定 cli 时覆盖最近 closed 会话 cli', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
    })
    const old = await sm.forceNew({
      userId: 'u1',
      platform: 'telegram',
      cli: 'opencode',
      cwd: '/opencode-project',
      text: '/new opencode',
      cliExplicit: true,
      cwdExplicit: true,
    })
    await sm.close(old, 'user')

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'opencode',
      cwd: '/opencode-project',
      text: '/new claude',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    const created = (await repos.conversations.listRecentByUser('telegram', 'u1', 10)).find(c => c.status === 'idle')
    expect(created?.cli).toBe('claude')
    expect(created?.cwd).toBe('/opencode-project')
  })

  test('/status 展示完整 conversationId', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
    })
    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: 'hi',
    })
    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/status',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    const content = (replies[0] as { content: string }).content
    expect(content).toContain('## 📊 当前会话')
    expect(content).toContain(`**会话 ID**: \`${cid}\``)
  })

  test('/status 当前会话存在时 Target 使用当前会话边界', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
    })
    await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'opencode',
      cwd: '/project',
      text: 'hi',
    })
    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old-target',
      text: '/status',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    const content = (replies[0] as { content: string }).content
    expect(content).toContain('**CLI**: `opencode`')
    expect(content).toContain('### 当前目标')
    expect(content).toContain('**CWD**: `/project`')
    expect(content).not.toContain('`claude`')
  })

  test('/audit 展示当前会话审批记录', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
    })
    const cid = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: 'hi',
    })
    await repos.audit.record({
      id: 'audit-1',
      conversationId: cid,
      command: 'command=Bash\napprovalId=a1\ndetail={"cmd":"rm x"}',
      action: 'approve',
      operator: 'u1',
      createdAt: 1_700_000_000_000,
    })
    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/audit',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    const content = (replies[0] as { content: string }).content
    expect(content).toContain('审批审计')
    expect(content).toContain(`Conversation: ${cid}`)
    expect(content).toContain('approved')
    expect(content).toContain('command=Bash')
  })

  test('/audit <shortId> 可查看自己的历史会话', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
    })
    const cid = await sm.forceNew({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/new',
    })
    await repos.audit.record({
      id: 'audit-1',
      conversationId: cid,
      command: 'command=Write',
      action: 'reject',
      operator: 'u1',
      createdAt: 1_700_000_000_000,
    })
    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/other',
      text: `/audit ${cid.slice(0, 8)}`,
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    const content = (replies[0] as { content: string }).content
    expect(content).toContain(`Conversation: ${cid}`)
    expect(content).toContain('rejected')
  })

  test('/remember 写入实例级全局记忆并广播 MemoryUpdated', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
    })
    const replies: unknown[] = []
    const updates: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))
    bus.on('MemoryUpdated', p => updates.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/remember preference: always use Bun',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    const memories = await repos.memories.listGlobal('global')
    expect(memories.length).toBe(1)
    expect(memories[0]!.namespace).toBe('global')
    expect(memories[0]!.conversationId).toBeNull()
    expect(memories[0]!.type).toBe('preference')
    expect(memories[0]!.content).toBe('always use Bun')
    expect((replies[0] as { content: string }).content).toContain('已记住')
    expect(updates).toEqual([
      {
        conversationId: null,
        namespace: 'global',
        memoryType: 'preference',
        memoryId: memories[0]!.id,
        operatorUserId: 'u1',
      },
    ])
  })

  test('/memory 查看全局记忆，/forget 短前缀删除', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
    })
    const memory = await repos.memories.insert({
      id: 'memory-abcdef',
      namespace: 'global',
      conversationId: null,
      type: 'semantic',
      content: '所有软件都放在 softs 文件夹',
      embedding: null,
      sourceMessageId: null,
      importance: 0.75,
      accessCount: 0,
      lastAccessedAt: null,
      tag: null,
      createdAt: 1,
    })
    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/memory',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })
    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: `/forget ${memory.id.slice(0, 8)}`,
      ref: { platform: 'telegram', chatId: 'c', nativeId: '2' },
    })

    expect((replies[0] as { content: string }).content).toContain('长期记忆')
    expect((replies[0] as { content: string }).content).toContain('**ID**: `memory-a`')
    expect((replies[0] as { content: string }).content).toContain('**Namespace**: `global`')
    expect((replies[0] as { content: string }).content).toContain('**Content**: 所有软件都放在 softs 文件夹')
    expect((replies[0] as { content: string }).content).toContain('所有软件都放在 softs 文件夹')
    expect((replies[0] as { content: string }).content).not.toContain('importance=')
    expect((replies[0] as { content: string }).content).not.toContain('semantic')
    expect((replies[1] as { content: string }).content).toContain('已删除记忆')
    expect(await repos.memories.listGlobal('global')).toEqual([])
  })

  test('/env 刷新并展示环境快照记忆', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    let refreshed = false
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
      refreshEnvironmentSnapshot: async () => {
        refreshed = true
        await repos.memories.upsertByTag('global', 'env.media', {
          conversationId: null,
          type: 'semantic',
          content: '环境画像：[媒体目录]\nMEDIA_DOWNLOAD_DIR=/tmp/media\nwritable=true',
          embedding: null,
          sourceMessageId: null,
          importance: 0.8,
          accessCount: 0,
          lastAccessedAt: null,
        })
      },
    })
    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/env',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    expect(refreshed).toBe(true)
    expect((replies[0] as { content: string }).content).toContain('环境快照')
    expect((replies[0] as { content: string }).content).toContain('MEDIA_DOWNLOAD_DIR=/tmp/media')
  })

  test('/health 返回注入的健康报告', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
      getHealthReport: async () => '**健康检查**\nStatus: ok',
    })
    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/health',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })

    expect(replies.length).toBe(1)
    expect((replies[0] as { content: string }).content).toBe('**健康检查**\nStatus: ok')
  })

  test('/update 预览计划，/update confirm 执行注入的自更新', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    let updated = false
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
      getUpdatePreview: () => '**自更新预检**\n确认执行请发送：/update confirm',
      performUpdate: async () => {
        updated = true
        return '**自更新完成**'
      },
    })
    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/update',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })
    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/update confirm',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '2' },
    })

    expect(updated).toBe(true)
    expect((replies[0] as { content: string }).content).toContain('自更新预检')
    expect((replies[1] as { content: string }).content).toContain('自更新完成')
  })

  test('/restart 预览计划，/restart confirm 执行注入的重启', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)
    let restartedRef: unknown
    const commandRouter = createCommandRouter({
      bus: bus as unknown as EventBus,
      repos,
      sessionManager: sm,
      getRestartPreview: () => '**重启预检**\n确认执行请发送：/restart confirm',
      performRestart: async ref => {
        restartedRef = ref
        return '**重启已安排**'
      },
    })
    const replies: unknown[] = []
    bus.on('CommandReply', p => replies.push(p))

    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/restart',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '1' },
    })
    await commandRouter.tryHandle({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/old',
      text: '/restart confirm',
      ref: { platform: 'telegram', chatId: 'c', nativeId: '2' },
    })

    expect(restartedRef).toEqual({ platform: 'telegram', chatId: 'c', nativeId: '2' })
    expect((replies[0] as { content: string }).content).toContain('重启预检')
    expect((replies[1] as { content: string }).content).toContain('重启已安排')
  })
})
