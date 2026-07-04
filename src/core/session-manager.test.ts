import { describe, expect, test } from 'bun:test'
import type { Conversation, NewConversation, ConversationId } from '../repository'
import type { EventBus } from '../event'
import { createSessionManager } from './session-manager'
import { createMessageRouter, type MockHandler } from './message-router'

// ---- In-memory mock repositories ----
function createMockRepos() {
  const conversations: Record<string, Conversation> = {}
  const messages: Array<Record<string, unknown>> = []

  function findActive(userId: string, cli: string, cwd: string): Conversation | null {
    return (
      Object.values(conversations)
        .reverse()
        .find(c => c.userId === userId && c.cli === cli && c.cwd === cwd && c.status !== 'closed') ?? null
    )
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
      async findActive(userId: string, cli: string, cwd: string) {
        return findActive(userId, cli, cwd)
      },
      async findById(id: string) {
        return conversations[id] ?? null
      },
      async updateStatus(id: string, status: string) {
        const c = conversations[id]
        if (c) {
          conversations[id] = { ...c, status: status as Conversation['status'], updatedAt: Date.now() }
        }
      },
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
    audit: {},
    memories: {},
  } as Parameters<typeof createSessionManager>[1]
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
    bus.on('SessionCreated', p => events.push(p))

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
  })

  test('不同 cwd 建不同会话', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)

    const cid1 = await sm.findOrCreate({ userId: 'u1', platform: 'telegram', cli: 'claude', cwd: '/a', text: 'hi' })
    const cid2 = await sm.findOrCreate({ userId: 'u1', platform: 'telegram', cli: 'claude', cwd: '/b', text: 'hi' })
    expect(cid1).not.toBe(cid2)
  })

  test('forceNew 将旧活跃置 idle 再新建', async () => {
    const bus = createMockBus()
    const repos = createMockRepos()
    const sm = createSessionManager(bus as unknown as EventBus, repos, 7)

    const cid1 = await sm.findOrCreate({
      userId: 'u1',
      platform: 'telegram',
      cli: 'claude',
      cwd: '/project',
      text: 'hi',
    })
    const cid2 = await sm.forceNew({ userId: 'u1', platform: 'telegram', cli: 'claude', cwd: '/project', text: '/new' })

    expect(cid1).not.toBe(cid2)
    expect((await repos.conversations.findById(cid1))?.status).toBe('idle')
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

    const handler: MockHandler = {
      async onMessage(text: string) {
        return `Echo: ${text}`
      },
    }

    createMessageRouter(bus as unknown as EventBus, repos, sm, handler)

    const generated: unknown[] = []
    bus.on('MessageGenerated', p => generated.push(p))

    bus.emit('MessageReceived', {
      conversationId: cid,
      userId: 'u1',
      platform: 'telegram',
      text: 'Hello from test',
      ref: { platform: 'telegram' as const, chatId: 'c', nativeId: '1' },
    })

    await new Promise(r => setTimeout(r, 10))

    const msgs = await repos.messages.listByConversation(cid)
    expect(msgs.length).toBeGreaterThanOrEqual(2)
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

    const failingHandler: MockHandler = {
      async onMessage() {
        throw new Error('Mock failure')
      },
    }

    createMessageRouter(bus as unknown as EventBus, repos, sm, failingHandler)

    const errors: unknown[] = []
    bus.on('ErrorOccurred', p => errors.push(p))

    bus.emit('MessageReceived', {
      conversationId: cid,
      userId: 'u1',
      platform: 'telegram',
      text: 'trigger error',
      ref: { platform: 'telegram' as const, chatId: 'c', nativeId: '1' },
    })

    await new Promise(r => setTimeout(r, 10))

    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect((errors[0] as Record<string, unknown>).scope).toBe('router:MessageReceived')
    expect((errors[0] as Record<string, unknown>).message).toContain('Mock failure')
  })
})
