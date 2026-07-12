/** 用户级持久化偏好：语言与默认 CLI（按 platform + userId 隔离）。 */
import { bigint, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { cliEnum, platformEnum } from './enums'

export const userPreferences = pgTable(
  'user_preferences',
  {
    platform: platformEnum('platform').notNull(),
    userId: text('user_id').notNull(),
    language: text('language').notNull().default('zh'),
    defaultCli: cliEnum('default_cli').notNull().default('claude'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  table => [primaryKey({ columns: [table.platform, table.userId], name: 'user_preferences_pkey' })],
)

/** 同一用户可分别保存每个 CLI 的工作目录。 */
export const userCliCwds = pgTable(
  'user_cli_cwds',
  {
    platform: platformEnum('platform').notNull(),
    userId: text('user_id').notNull(),
    cli: cliEnum('cli').notNull(),
    cwd: text('cwd').notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  table => [primaryKey({ columns: [table.platform, table.userId, table.cli], name: 'user_cli_cwds_pkey' })],
)

export type UserPreference = typeof userPreferences.$inferSelect
export type UserCliCwd = typeof userCliCwds.$inferSelect
