/**
 * conversations —— 会话元数据（docs/04-Data-Model.md §3）。
 * 会话边界 = (userId, cli, cwd)：见 docs/02-Architecture.md §5.1。
 */
import { pgTable, text, bigint, index } from 'drizzle-orm/pg-core'
import { platformEnum, cliEnum, sessionStatusEnum } from './enums'

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    platform: platformEnum('platform').notNull(),
    userId: text('user_id').notNull(),
    cli: cliEnum('cli').notNull(),
    cwd: text('cwd').notNull(), // 会话边界：项目目录
    status: sessionStatusEnum('status').notNull().default('idle'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  t => [
    // 会话边界定位：(user, cli, cwd, status) 复用/新建
    index('idx_conv_active').on(t.userId, t.cli, t.cwd, t.status),
    // 归档扫描：按 status + updatedAt
    index('idx_conv_archive').on(t.status, t.updatedAt),
  ],
)

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
