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
    expect(t.columns.map(column => column.name)).toEqual(
      expect.arrayContaining(['attachments', 'context_eligible', 'message_type', 'audit_log_id']),
    )
    expect(t.columns.find(column => column.name === 'message_type')?.default).toBe('chat')
    expect(t.columns.find(column => column.name === 'audit_log_id')?.notNull).toBe(false)
    expect(t.foreignKeys).toHaveLength(2)
    expect(t.foreignKeys.map(key => key.onDelete)).toEqual(expect.arrayContaining(['cascade', 'no action']))
    expect(t.indexes.map(index => index.config.name)).toContain('uniq_msg_audit_log')
    expect(t.checks.map(check => check.name)).toContain('messages_attachments_array')
  })

  test('audit_logs：外键不级联删除（审计永久）', () => {
    const t = getTableConfig(auditLogs)
    expect(t.name).toBe('audit_logs')
    const columns = t.columns.map(column => column.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'conversation_id',
        'approval_id',
        'request',
        'status',
        'operator',
        'automatic',
        'created_at',
      ]),
    )
    expect(columns).not.toContain('command')
    expect(columns).not.toContain('action')
    expect(t.columns.find(column => column.name === 'operator')?.notNull).toBe(false)
    expect(t.columns.find(column => column.name === 'automatic')?.default).toBe(false)
    expect(t.foreignKeys).toHaveLength(1)
    // onDelete = no action（非 cascade）→ 审计不随会话删除
    expect(t.foreignKeys[0]!.onDelete).toBe('no action')
    expect(t.indexes.map(index => index.config.name)).toEqual(
      expect.arrayContaining(['idx_audit_conv', 'uniq_audit_conversation_approval']),
    )
    expect(t.checks.map(check => check.name)).toContain('audit_logs_request_object')
  })

  test('Bun SQL JSONB 写入保持原生数组和对象，不提前序列化', () => {
    const messageTable = getTableConfig(messages)
    const attachments = messageTable.columns.find(column => column.name === 'attachments')!
    expect(attachments.mapToDriverValue([])).toEqual([])

    const auditTable = getTableConfig(auditLogs)
    const request = auditTable.columns.find(column => column.name === 'request')!
    const value = { command: 'Bash', detail: { command: 'git status --short' } }
    expect(request.mapToDriverValue(value)).toEqual(value)
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

  test('文件标识迁移先解除 file_id 非空约束，再把无稳定标识的平台更新为 NULL', async () => {
    const migration = await readFile(path.resolve('drizzle/0013_conversation_file_identifier.sql'), 'utf8')
    const dropNotNullAt = migration.indexOf('ALTER COLUMN "file_id" DROP NOT NULL')
    const updateAt = migration.indexOf('UPDATE "conversation_files"')
    expect(dropNotNullAt).toBeGreaterThanOrEqual(0)
    expect(updateAt).toBeGreaterThan(dropNotNullAt)
  })

  test('斜杠命令清理迁移同时删除命令输入与对应的本地回复', async () => {
    const migration = await readFile(path.resolve('drizzle/0017_remove_slash_command_messages.sql'), 'utf8')
    expect(migration).toContain(`"content" ~ '^[[:space:]]*/'`)
    expect(migration).toContain(`grouped_messages."role" = 'user'`)
    expect(migration).toContain(`grouped_messages."role" = 'assistant'`)
    expect(migration).toContain(`grouped_messages."context_eligible" = false`)
  })

  test('结构化审批迁移先清空旧审计，再替换 packed 字段并建立消息引用', async () => {
    const migration = await readFile(path.resolve('drizzle/0018_structured_approval_timeline.sql'), 'utf8')
    const clearAt = migration.indexOf('DELETE FROM "audit_logs"')
    const dropCommandAt = migration.indexOf('DROP COLUMN "command"')
    const dropActionAt = migration.indexOf('DROP COLUMN "action"')
    const dropActionEnumAt = migration.indexOf('DROP TYPE "public"."approval_action"')
    expect(clearAt).toBeGreaterThanOrEqual(0)
    expect(dropCommandAt).toBeGreaterThan(clearAt)
    expect(dropActionAt).toBeGreaterThan(clearAt)
    expect(dropActionEnumAt).toBeGreaterThan(dropActionAt)
    expect(migration).toContain('ADD COLUMN "message_type" "message_type" DEFAULT \'chat\' NOT NULL')
    expect(migration).toContain('ADD COLUMN "audit_log_id" text')
    expect(migration).toContain('FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_logs"("id")')
    expect(migration).toContain('CREATE UNIQUE INDEX "uniq_msg_audit_log"')
  })

  test('Bun JSONB 归一化迁移先解析旧字符串，再增加数组和对象约束', async () => {
    const migration = await readFile(path.resolve('drizzle/0019_normalize_bun_jsonb.sql'), 'utf8')
    const normalizeAttachmentsAt = migration.indexOf('SET "attachments" = ("attachments" #>> \'{}\')::jsonb')
    const normalizeRequestAt = migration.indexOf('SET "request" = ("request" #>> \'{}\')::jsonb')
    const attachmentsConstraintAt = migration.indexOf('CONSTRAINT "messages_attachments_array"')
    const requestConstraintAt = migration.indexOf('CONSTRAINT "audit_logs_request_object"')
    expect(normalizeAttachmentsAt).toBeGreaterThanOrEqual(0)
    expect(normalizeRequestAt).toBeGreaterThanOrEqual(0)
    expect(attachmentsConstraintAt).toBeGreaterThan(normalizeAttachmentsAt)
    expect(requestConstraintAt).toBeGreaterThan(normalizeRequestAt)
    expect(migration).toContain(`jsonb_typeof("attachments") = 'string'`)
    expect(migration).toContain(`jsonb_typeof("request") = 'string'`)
    expect(migration).toContain(`jsonb_typeof("attachments") = 'array'`)
    expect(migration).toContain(`jsonb_typeof("request") = 'object'`)
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
