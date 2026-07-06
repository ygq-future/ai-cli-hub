/**
 * 仓储集成测试 —— 真·连库 CRUD（docs/05 M2 验收）。
 * 需环境变量 TEST_DATABASE_URL 指向一个可写的 Postgres（含 pgvector 扩展，如 pgvector/pgvector 镜像）。
 * 未配置则整组 skip —— 本机无库时不阻塞 `bun test`。
 *
 * 置于 src/ 之外：dependency-cruiser 仅巡检 src/，eslint 的 env 限制亦仅作用于 src/**，
 * 故此处允许读 process.env.TEST_DATABASE_URL。
 *
 * 运行：TEST_DATABASE_URL=postgres://... bun test test/repository.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { eq, inArray } from 'drizzle-orm'
import { createDb, type Db } from '../src/storage'
import { auditLogs, conversations, memories } from '../src/storage/schema'
import { createRepositories, type Repositories } from '../src/repository'
import type { ConversationId } from '../src/shared'

const url = process.env.TEST_DATABASE_URL

const cid = crypto.randomUUID() as string as ConversationId
const now = Date.now()
const testNamespace = `test-${crypto.randomUUID()}`

describe.skipIf(!url)('Repositories 集成 CRUD', () => {
  let db: Db
  let repos: Repositories

  beforeAll(async () => {
    db = createDb(url!)
    await migrate(db, { migrationsFolder: './drizzle' })
    repos = createRepositories(db)
  })

  afterAll(async () => {
    // 清理本测试插入的数据（audit 无级联，先删；其余随 conversation 级联/置空）。
    await db.delete(auditLogs).where(inArray(auditLogs.conversationId, [cid]))
    await db.delete(memories).where(inArray(memories.conversationId, [cid]))
    await db.delete(conversations).where(inArray(conversations.id, [cid]))
  })

  test('ConversationRepository：create → findById → findActive → updateStatus → listStaleIdle', async () => {
    const created = await repos.conversations.create({
      id: cid,
      platform: 'telegram',
      userId: 'u-int',
      cli: 'claude',
      cwd: '/tmp/proj',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    })
    expect(created.id).toBe(cid)

    const byId = await repos.conversations.findById(cid)
    expect(byId?.userId).toBe('u-int')

    const active = await repos.conversations.findActive('u-int', 'claude', '/tmp/proj')
    expect(active?.id).toBe(cid)

    await repos.conversations.updateStatus(cid, 'idle')
    const afterIdle = await repos.conversations.findById(cid)
    expect(afterIdle?.status).toBe('idle')

    const stale = await repos.conversations.listStaleIdle(Date.now() + 1_000)
    expect(stale.some(c => c.id === cid)).toBe(true)
  })

  test('MessageRepository：append → listByConversation（时间正序）', async () => {
    await repos.messages.append({
      id: crypto.randomUUID(),
      conversationId: cid,
      role: 'user',
      content: '第一条',
      createdAt: now,
    })
    await repos.messages.append({
      id: crypto.randomUUID(),
      conversationId: cid,
      role: 'assistant',
      content: '第二条',
      createdAt: now + 10,
    })
    const list = await repos.messages.listByConversation(cid)
    expect(list.map(m => m.content)).toEqual(['第一条', '第二条'])
    expect(await repos.messages.listByConversation(cid, 1)).toHaveLength(1)
  })

  test('AuditRepository：record → listByConversation（永久留痕）', async () => {
    await repos.audit.record({
      id: crypto.randomUUID(),
      conversationId: cid,
      command: 'rm -rf build',
      action: 'approve',
      operator: 'u-int',
      createdAt: now,
    })
    const logs = await repos.audit.listByConversation(cid)
    expect(logs).toHaveLength(1)
    expect(logs[0]!.action).toBe('approve')
  })

  test('MemoryRepository：insert → listGlobal → searchByKeyword → touch/delete/upsert；searchByVector 抛错', async () => {
    // global（conversationId 为 NULL）
    const mem = await repos.memories.insert({
      id: crypto.randomUUID(),
      namespace: testNamespace,
      conversationId: null,
      type: 'preference',
      content: 'prefers dark mode and terse replies',
      createdAt: now,
    })
    expect(mem.conversationId).toBeNull()

    const global = await repos.memories.listGlobal(testNamespace)
    expect(global.some(m => m.id === mem.id)).toBe(true)

    const hits = await repos.memories.searchByKeyword(testNamespace, 'dark mode', 5)
    expect(hits.some(m => m.id === mem.id)).toBe(true)

    await repos.memories.touch(mem.id)
    const touched = (await repos.memories.listGlobal(testNamespace)).find(m => m.id === mem.id)
    expect(touched?.accessCount).toBe(1)
    expect(touched?.lastAccessedAt).not.toBeNull()

    const upserted = await repos.memories.upsertByTag(testNamespace, 'env:test', {
      conversationId: null,
      type: 'semantic',
      content: 'environment snapshot v1',
      importance: 0.9,
    })
    const updated = await repos.memories.upsertByTag(testNamespace, 'env:test', {
      conversationId: null,
      type: 'semantic',
      content: 'environment snapshot v2',
      importance: 0.9,
    })
    expect(updated.id).toBe(upserted.id)
    expect(updated.content).toBe('environment snapshot v2')

    const byId = await repos.memories.findById(mem.id)
    expect(byId?.id).toBe(mem.id)

    await repos.memories.delete(mem.id)
    expect(await repos.memories.findById(mem.id)).toBeNull()
    await db.delete(memories).where(eq(memories.id, upserted.id))

    expect(repos.memories.searchByVector(testNamespace, [0.1, 0.2], 5)).rejects.toThrow(/V1\.5/)
  })
})
