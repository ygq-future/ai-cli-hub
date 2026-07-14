/**
 * schema 离线单测 —— 无需连库，校验四表结构/枚举/索引与 pgvector 序列化契约（docs/04）。
 * 真·连库 CRUD 见 test/repository.integration.test.ts（需 TEST_DATABASE_URL）。
 */
import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { getTableConfig } from 'drizzle-orm/pg-core'
import {
  conversations,
  conversationFiles,
  messages,
  auditLogs,
  memories,
  userCliPreferences,
  userPreferences,
} from './schema'

describe('schema — 表结构与契约', () => {
  test('conversations：列 + 复合索引', () => {
    const t = getTableConfig(conversations)
    expect(t.name).toBe('conversations')
    const cols = t.columns.map(c => c.name)
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'platform', 'user_id', 'cli', 'cwd', 'status', 'created_at', 'updated_at']),
    )
    const idx = t.indexes.map(i => i.config.name)
    expect(idx).toEqual(expect.arrayContaining(['idx_conv_scope_recent', 'uniq_conv_open_scope', 'idx_conv_archive']))
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

  test('memories：不再关联会话/消息，保留 namespace + vector(1024) + FTS', () => {
    const t = getTableConfig(memories)
    expect(t.name).toBe('memories')
    const cols = t.columns.map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining(['id', 'namespace', 'type', 'content', 'tag']))
    expect(cols).not.toContain('conversation_id')
    expect(cols).not.toContain('source_message_id')

    const embedding = t.columns.find(c => c.name === 'embedding')
    expect(embedding).toBeDefined()
    expect(embedding!.getSQLType()).toBe('vector(1024)')

    expect(t.foreignKeys).toHaveLength(0)

    const fts = t.indexes.find(i => i.config.name === 'idx_mem_fts')
    expect(fts).toBeDefined()
    expect(fts!.config.method).toBe('gin')

    const idx = t.indexes.map(i => i.config.name)
    expect(idx).toEqual(expect.arrayContaining(['idx_mem_namespace', 'uniq_mem_tag']))
  })

  test('conversation_files：会话内编号唯一且会话删除时级联清理映射', () => {
    const table = getTableConfig(conversationFiles)
    expect(table.columns.map(column => column.name)).toEqual(
      expect.arrayContaining(['conversation_id', 'sequence', 'kind', 'file_id', 'local_path', 'created_at']),
    )
    expect(table.columns.map(column => column.name)).not.toContain('file_unique_id')
    expect(table.columns.find(column => column.name === 'file_id')?.notNull).toBe(false)
    expect(table.foreignKeys[0]?.onDelete).toBe('cascade')
    expect(table.indexes.map(index => index.config.name)).toContain('uniq_conversation_file_sequence')
  })

  test('每个 SQL 迁移都登记在 Drizzle journal，避免 db:migrate 静默跳过', async () => {
    const drizzleDirectory = path.resolve('drizzle')
    const sqlTags = (await readdir(drizzleDirectory))
      .filter(fileName => fileName.endsWith('.sql'))
      .map(fileName => path.basename(fileName, '.sql'))
      .sort()
    const journal = JSON.parse(await readFile(path.join(drizzleDirectory, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>
    }
    expect(journal.entries.map(entry => entry.tag).sort()).toEqual(sqlTags)
  })

  test('pgvector 序列化：number[] → 文本字面量 [a,b,c]', () => {
    const t = getTableConfig(memories)
    const embedding = t.columns.find(c => c.name === 'embedding')!
    expect(embedding.mapToDriverValue([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]')
  })

  test('用户偏好：按 platform + userId 隔离语言、默认 CLI 和每 CLI 偏好', () => {
    const preferences = getTableConfig(userPreferences)
    expect(preferences.columns.map(column => column.name)).toEqual(
      expect.arrayContaining([
        'platform',
        'user_id',
        'language',
        'default_cli',
        'auto_approve_enabled',
        'auto_approve_seconds',
      ]),
    )
    expect(preferences.primaryKeys).toHaveLength(1)

    const cliPreferences = getTableConfig(userCliPreferences)
    expect(cliPreferences.columns.map(column => column.name)).toEqual(
      expect.arrayContaining(['platform', 'user_id', 'cli', 'cwd', 'model_id', 'model_name']),
    )
    expect(cliPreferences.primaryKeys).toHaveLength(1)
  })
})
