/**
 * 迁移应用器 —— bun-sql 原生 migrator（不依赖 pg/postgres 外部驱动，遵 PROGRESS D8）。
 *
 * 为何不用 `drizzle-kit migrate`：drizzle-kit 的 migrate/push 需 pg/postgres 等驱动包，
 * 而本项目运行时走 Bun 内置 SQL、不引额外驱动。故 apply 走本脚本；`db:generate`（离线）仍用 drizzle-kit。
 *
 * 构建/运维脚本，非运行时模块，置于 src/ 外，允许直接读 DATABASE_URL。
 * 用法：DATABASE_URL=postgres://... bun run db:migrate
 */
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb } from '../src/storage'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('✖ DATABASE_URL 未设置，无法应用迁移')
  process.exit(1)
}

const db = createDb(url)
await migrate(db, { migrationsFolder: './drizzle' })
await db.$client.end()
console.log('✔ 迁移已应用（drizzle/）')
