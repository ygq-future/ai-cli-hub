/**
 * 迁移应用器 —— bun-sql 原生 migrator（不依赖 pg/postgres 外部驱动，遵 PROGRESS D8）。
 *
 * 为何不用 `drizzle-kit migrate`：drizzle-kit 的 migrate/push 需 pg/postgres 等驱动包，
 * 而本项目运行时走 Bun 内置 SQL、不引额外驱动。故 apply 走本脚本；`db:generate`（离线）仍用 drizzle-kit。
 *
 * 数据库连接与主程序使用同一 settings.json 强类型配置。
 * 用法：bun run db:migrate
 */
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { loadConfig } from '../src/config'
import { createDb } from '../src/storage'

const config = loadConfig()
const db = createDb(config.DATABASE_URL)
await migrate(db, { migrationsFolder: './drizzle' })
await db.$client.end()
console.log('✔ 迁移已应用（drizzle/）')
