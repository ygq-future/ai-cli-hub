import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../config'
import { createEventBus } from '../event'
import type { Memory, NewMemory, Repositories } from '../repository'
import { createMemoryModule, formatGlobalMemoryContext } from './index'

const CONFIG = loadConfig({
  TELEGRAM_BOT_TOKEN: 'token',
  WHITELIST_USER_IDS: 'u1',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  EMBEDDING_API_KEY: 'sk-test',
  DEFAULT_CWD: 'D:/workspace/project',
})

function createMemoryRepos() {
  const memories: Memory[] = []
  const repos = {
    memories: {
      async insert(m: NewMemory) {
        const row = m as Memory
        memories.push(row)
        return row
      },
      async upsertByTag(namespace: string, tag: string, m: Omit<NewMemory, 'id' | 'namespace' | 'tag' | 'createdAt'>) {
        const existing = memories.find(row => row.namespace === namespace && row.tag === tag)
        if (existing) {
          Object.assign(existing, m, { namespace, tag })
          return existing
        }
        const row = { ...m, id: crypto.randomUUID(), namespace, tag, createdAt: Date.now() } as Memory
        memories.push(row)
        return row
      },
      async listGlobal(namespace: string) {
        return memories.filter(row => row.namespace === namespace && row.conversationId === null)
      },
      async findById(id: string) {
        return memories.find(row => row.id === id) ?? null
      },
      async searchByKeyword() {
        return []
      },
      async searchByVector() {
        return []
      },
      async touch() {},
      async delete(id: string) {
        const idx = memories.findIndex(row => row.id === id)
        if (idx >= 0) memories.splice(idx, 1)
      },
    },
  } as unknown as Repositories
  return { repos, memories }
}

describe('memory module', () => {
  test('createMemoryModule 启动时按稳定 tag upsert 环境快照', async () => {
    const bus = createEventBus()
    const { repos, memories } = createMemoryRepos()
    const updates: unknown[] = []
    bus.on('MemoryUpdated', p => updates.push(p))

    await createMemoryModule({ bus, repos, config: CONFIG })
    const firstCount = memories.length
    await createMemoryModule({ bus, repos, config: CONFIG })

    expect(firstCount).toBeGreaterThanOrEqual(10)
    expect(memories.length).toBe(firstCount)
    expect(memories.some(m => m.tag === 'env.os')).toBe(true)
    expect(memories.some(m => m.tag === 'env.default_cwd' && m.content.includes('D:/workspace/project'))).toBe(true)
    expect(updates.length).toBeGreaterThanOrEqual(firstCount * 2)
  })

  test('recallGlobalContext 格式化全局记忆并排除会话级记忆', async () => {
    const bus = createEventBus()
    const { repos } = createMemoryRepos()
    await repos.memories.insert({
      id: 'm1',
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
    await repos.memories.insert({
      id: 'm2',
      namespace: 'global',
      conversationId: 'conv-1',
      type: 'episodic',
      content: '不应全量注入的会话摘要',
      embedding: null,
      sourceMessageId: null,
      importance: 0.5,
      accessCount: 0,
      lastAccessedAt: null,
      tag: null,
      createdAt: 2,
    } as Memory)

    const memory = await createMemoryModule({ bus, repos, config: CONFIG })
    const context = await memory.recallGlobalContext()

    expect(context).toContain('[长期记忆 · 供参考]')
    expect(context).toContain('所有软件都放在 softs 文件夹')
    expect(context).not.toContain('不应全量注入的会话摘要')
  })

  test('formatGlobalMemoryContext 空列表返回空串', () => {
    expect(formatGlobalMemoryContext([])).toBe('')
  })
})
