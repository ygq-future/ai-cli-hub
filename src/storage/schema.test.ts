/**
 * schema 离线单测 —— 无需连库，校验四表结构/枚举/索引与 pgvector 序列化契约（docs/04）。
 * 真·连库 CRUD 见 test/repository.integration.test.ts（需 TEST_DATABASE_URL）。
 */
import { describe, expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { conversations, messages, auditLogs, memories } from './schema'

describe('schema — 表结构与契约', () => {
  test('conversations：列 + 复合索引', () => {
    const t = getTableConfig(conversations)
    expect(t.name).toBe('conversations')
    const cols = t.columns.map(c => c.name)
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'platform', 'user_id', 'cli', 'cwd', 'status', 'created_at', 'updated_at']),
    )
    const idx = t.indexes.map(i => i.config.name)
    expect(idx).toEqual(expect.arrayContaining(['idx_conv_active', 'idx_conv_archive']))
  })

  test('messages：级联外键指向 conversations', () => {
    const t = getTableConfig(messages)
    expect(t.name).toBe('messages')
    expect(t.foreignKeys).toHaveLength(1)
    expect(t.foreignKeys[0]!.onDelete).toBe('cascade')
  })

  test('audit_logs：外键不级联删除（审计永久）', () => {
    const t = getTableConfig(auditLogs)
    expect(t.name).toBe('audit_logs')
    expect(t.foreignKeys).toHaveLength(1)
    // onDelete = no action（非 cascade）→ 审计不随会话删除
    expect(t.foreignKeys[0]!.onDelete).toBe('no action')
  })

  test('memories：namespace + 向量列 vector(1536) + FTS gin 索引 + set null 外键', () => {
    const t = getTableConfig(memories)
    expect(t.name).toBe('memories')
    const cols = t.columns.map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining(['id', 'namespace', 'conversation_id', 'type', 'content', 'tag']))

    const embedding = t.columns.find(c => c.name === 'embedding')
    expect(embedding).toBeDefined()
    expect(embedding!.getSQLType()).toBe('vector(1536)')

    expect(t.foreignKeys[0]!.onDelete).toBe('set null')

    const fts = t.indexes.find(i => i.config.name === 'idx_mem_fts')
    expect(fts).toBeDefined()
    expect(fts!.config.method).toBe('gin')

    const idx = t.indexes.map(i => i.config.name)
    expect(idx).toEqual(expect.arrayContaining(['idx_mem_namespace', 'uniq_mem_tag']))
  })

  test('pgvector 序列化：number[] → 文本字面量 [a,b,c]', () => {
    const t = getTableConfig(memories)
    const embedding = t.columns.find(c => c.name === 'embedding')!
    expect(embedding.mapToDriverValue([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]')
  })
})
