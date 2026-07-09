import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../config'
import { createEventBus } from '../event'
import type { Memory, Message, NewMemory, Repositories } from '../repository'
import type { ConversationId } from '../shared'
import {
  collectEnvironmentFacts,
  createMemoryModule,
  formatConversationSummaryMemory,
  formatGlobalMemoryContext,
} from './index'

const CONFIG = loadConfig({
  TELEGRAM_BOT_TOKEN: 'token',
  WHITELIST_USER_IDS: 'u1',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  EMBEDDING_API_KEY: 'sk-test',
  DEFAULT_CWD: 'D:/workspace/project',
})

function createMemoryRepos() {
  const memories: Memory[] = []
  const messages: Message[] = []
  const repos = {
    messages: {
      async listByConversation(conversationId: ConversationId) {
        return messages.filter(row => row.conversationId === conversationId)
      },
    },
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
      async setEmbedding(id: string, embedding: number[]) {
        const memory = memories.find(row => row.id === id)
        if (memory) memory.embedding = embedding
      },
      async touch() {},
      async delete(id: string) {
        const idx = memories.findIndex(row => row.id === id)
        if (idx >= 0) memories.splice(idx, 1)
      },
    },
  } as unknown as Repositories
  return { repos, memories, messages }
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

    expect(firstCount).toBeGreaterThanOrEqual(7)
    expect(memories.length).toBe(firstCount)
    expect(memories.some(m => m.tag === 'env.os')).toBe(true)
    expect(memories.some(m => m.tag === 'env.default_cwd' && m.content.includes('D:/workspace/project'))).toBe(true)
    expect(memories.some(m => m.tag === 'env.container')).toBe(true)
    expect(memories.some(m => m.tag === 'env.service_manager')).toBe(true)
    expect(memories.some(m => m.tag === 'env.media')).toBe(true)
    expect(updates.length).toBeGreaterThanOrEqual(firstCount * 2)
  })

  test('collectEnvironmentFacts 生成 VPS 运维画像并包含媒体目录', async () => {
    const facts = await collectEnvironmentFacts(CONFIG)
    const tags = facts.map(f => f.tag)
    const content = facts.map(f => f.content).join('\n')

    expect(tags).toContain('env.container')
    expect(tags).toContain('env.service_manager')
    expect(tags).toContain('env.media')
    expect(tags).not.toContain('env.network')
    expect(content).toContain('docker=')
    expect(content).toContain('pm2=')
    expect(content).toContain('MEDIA_DOWNLOAD_DIR=')
    expect(content).not.toContain('docker containers=')
    expect(content).not.toContain('listening tcp=')
    expect(content).not.toContain(' disk=')
    if (process.platform !== 'win32') {
      expect(tags).not.toContain('env.powershell')
      expect(content).not.toContain('Windows PowerShell')
    }
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

    const memory = await createMemoryModule({
      bus,
      repos,
      config: CONFIG,
      embeddingProvider: { embed: async () => Array(1024).fill(0) },
    })
    const context = await memory.recallGlobalContext()

    expect(context).toContain('[长期记忆 · 供参考]')
    expect(context).toContain('所有软件都放在 softs 文件夹')
    expect(context).not.toContain('不应全量注入的会话摘要')
  })

  test('formatGlobalMemoryContext 空列表返回空串', () => {
    expect(formatGlobalMemoryContext([])).toBe('')
  })

  test('SessionClosed 后把会话摘录写入 conversation-derived episodic 记忆并回填 embedding', async () => {
    const bus = createEventBus()
    const { repos, memories, messages } = createMemoryRepos()
    messages.push(
      {
        id: 'u1',
        conversationId: 'conv-summary',
        role: 'user',
        content: '这个项目怎么用 PM2 部署？',
        createdAt: 1,
      } as Message,
      {
        id: 'a1',
        conversationId: 'conv-summary',
        role: 'assistant',
        content: '使用 pm2 start deploy/pm2.config.cjs，并确认服务名是 ai-cli-hub。',
        createdAt: 2,
      } as Message,
    )
    const module = await createMemoryModule({
      bus,
      repos,
      config: CONFIG,
      embeddingProvider: { embed: async () => Array(1024).fill(0.4) },
    })

    bus.emit('SessionClosed', { conversationId: 'conv-summary' as ConversationId, reason: 'user' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    const summary = memories.find(m => m.tag === 'conversation.summary:conv-summary')
    expect(summary?.conversationId).toBe('conv-summary')
    expect(summary?.type).toBe('episodic')
    expect(summary?.content).toContain('会话派生记忆')
    expect(summary?.content).toContain('ai-cli-hub')
    expect(summary?.embedding).toHaveLength(1024)
    module.destroy()
  })

  test('formatConversationSummaryMemory 少于两条对话消息时不生成摘要', () => {
    expect(
      formatConversationSummaryMemory('conv-empty', [
        {
          id: 'u1',
          conversationId: 'conv-empty',
          role: 'user',
          content: '只有一条消息',
          createdAt: 1,
        } as Message,
      ]),
    ).toBe('')
  })

  test('MemorySummaryRequested 使用最近 10 条 DB user/assistant 消息做 LLM 摘要并写入记忆', async () => {
    const bus = createEventBus()
    const { repos, memories, messages } = createMemoryRepos()
    const seenBatches: Message[][] = []
    const seenLanguages: string[] = []
    messages.push({
      id: 'sdk-json',
      conversationId: 'conv-remember',
      role: 'system',
      content: 'Agent SDK raw message {"type":"assistant","message":{"content":[{"type":"tool_use"}]}}',
      createdAt: 0,
    } as Message)
    for (let i = 1; i <= 12; i++) {
      messages.push({
        id: `m${i}`,
        conversationId: 'conv-remember',
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `db-message-${i}`,
        createdAt: i,
      } as Message)
    }

    const module = await createMemoryModule({
      bus,
      repos,
      config: CONFIG,
      summaryProvider: {
        async summarizeRecentMessages(batch, _userRequest, language) {
          seenBatches.push(batch)
          seenLanguages.push(language)
          return '用户希望记住：PowerShell 脚本目录位于 E:/library/documents/PowerShell。'
        },
      },
      embeddingProvider: { embed: async () => Array(1024).fill(0.5) },
    })

    bus.emit('MemorySummaryRequested', {
      conversationId: 'conv-remember' as ConversationId,
      userId: 'u1',
      language: 'zh',
      reason: 'userRememberRequest',
      text: '没事,你记住在这个地方就行了',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(seenBatches).toHaveLength(1)
    expect(seenLanguages).toEqual(['zh'])
    expect(seenBatches[0]!.map(m => m.content)).toEqual(Array.from({ length: 10 }, (_, idx) => `db-message-${idx + 3}`))
    expect(seenBatches[0]!.some(m => m.content.includes('SDK raw'))).toBe(false)
    const memory = memories.find(m => m.content.includes('PowerShell 脚本目录'))
    expect(memory?.conversationId).toBe('conv-remember')
    expect(memory?.type).toBe('episodic')
    expect(memory?.embedding).toHaveLength(1024)
    module.destroy()
  })

  test('MemoryUpdated 后异步回填会话派生记忆 embedding，跳过 global 记忆', async () => {
    const bus = createEventBus()
    const { repos, memories } = createMemoryRepos()
    let embedCalls = 0
    const module = await createMemoryModule({
      bus,
      repos,
      config: CONFIG,
      embeddingProvider: {
        embed: async () => {
          embedCalls++
          return Array(1024).fill(0.1)
        },
      },
    })
    await repos.memories.insert({
      id: 'm-global',
      namespace: 'global',
      conversationId: null,
      type: 'preference',
      content: '喜欢最短可行方案',
      embedding: null,
      sourceMessageId: null,
      importance: 0.8,
      accessCount: 0,
      lastAccessedAt: null,
      tag: null,
      createdAt: 1,
    })
    await repos.memories.insert({
      id: 'm-embed',
      namespace: 'global',
      conversationId: 'conv-1',
      type: 'episodic',
      content: '某次会话中确认 PM2 服务名是 ai-cli-hub',
      embedding: null,
      sourceMessageId: null,
      importance: 0.8,
      accessCount: 0,
      lastAccessedAt: null,
      tag: null,
      createdAt: 2,
    } as Memory)

    bus.emit('MemoryUpdated', {
      conversationId: null,
      namespace: 'global',
      memoryType: 'preference',
      memoryId: 'm-global',
    })
    bus.emit('MemoryUpdated', {
      conversationId: 'conv-1' as ConversationId,
      namespace: 'global',
      memoryType: 'episodic',
      memoryId: 'm-embed',
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(embedCalls).toBe(1)
    expect(memories.find(m => m.id === 'm-global')?.embedding).toBeNull()
    expect(memories.find(m => m.id === 'm-embed')?.embedding).toHaveLength(1024)
    module.destroy()
  })

  test('recallRelevantContext 使用 query embedding 召回 Top-K 相关记忆', async () => {
    const bus = createEventBus()
    const { repos, memories } = createMemoryRepos()
    const semanticMemory = {
      id: 'm-related',
      namespace: 'global',
      conversationId: 'conv-1',
      type: 'episodic',
      content: '上次排查过 PM2 restart 后环境画像刷新。',
      embedding: Array(1024).fill(0.2),
      sourceMessageId: null,
      importance: 0.8,
      accessCount: 0,
      lastAccessedAt: null,
      tag: null,
      createdAt: 1,
    } as Memory
    const globalMemory = {
      id: 'm-global',
      namespace: 'global',
      conversationId: null,
      type: 'preference',
      content: '全局偏好已经由 system hint 全量注入，不应再语义召回。',
      embedding: Array(1024).fill(0.2),
      sourceMessageId: null,
      importance: 0.8,
      accessCount: 0,
      lastAccessedAt: null,
      tag: null,
      createdAt: 2,
    } as Memory
    memories.push(semanticMemory)
    memories.push(globalMemory)
    repos.memories.searchByVector = async (_namespace: string, _embedding: number[], topK: number) =>
      memories.slice(0, topK)
    repos.memories.touch = async (id: string) => {
      const memory = memories.find(row => row.id === id)
      if (memory) memory.accessCount += 1
    }
    const module = await createMemoryModule({
      bus,
      repos,
      config: CONFIG,
      embeddingProvider: { embed: async text => (text.includes('PM2') ? Array(1024).fill(0.3) : Array(1024).fill(0)) },
    })

    const context = await module.recallRelevantContext('PM2 怎么重启？')

    expect(context).toContain('[相关长期记忆 · 语义召回]')
    expect(context).toContain('PM2 restart')
    expect(context).not.toContain('全局偏好')
    expect(semanticMemory.accessCount).toBe(1)
    expect(globalMemory.accessCount).toBe(0)
    module.destroy()
  })
})
