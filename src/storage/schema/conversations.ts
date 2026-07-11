/**
 * conversations —— 会话元数据（docs/04-Data-Model.md §3）。
 * 会话 scope = (platform, userId)：见 docs/02-Architecture.md §5.1。
 */
import { sql } from 'drizzle-orm'
import { pgTable, text, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { platformEnum, cliEnum, sessionStatusEnum } from './enums'

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    platform: platformEnum('platform').notNull(),
    userId: text('user_id').notNull(),
    cli: cliEnum('cli').notNull(),
    cwd: text('cwd').notNull(), // 当前会话目标目录，不参与 scope
    status: sessionStatusEnum('status').notNull().default('idle'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  t => [
    // 会话 scope：(platform, user)。CLI/cwd 切换仍复用或替换同一 scope 会话。
    index('idx_conv_scope_recent').on(t.platform, t.userId, t.updatedAt),
    // 数据库兜底：每个 scope 至多一条未关闭会话，防止并发入站建出重复会话。
    uniqueIndex('uniq_conv_open_scope')
      .on(t.platform, t.userId)
      .where(sql`${t.status} <> 'closed'`),
    // 归档扫描：按 status + updatedAt
    index('idx_conv_archive').on(t.status, t.updatedAt),
  ],
)

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
