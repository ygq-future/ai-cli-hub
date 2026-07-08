/**
 * Drizzle 连接 —— 运行时唯一 DB 客户端工厂（docs/03-Interface-Contracts.md §7）。
 * 驱动：drizzle-orm/bun-sql（Bun 内置 SQL，零额外驱动依赖，遵 CLAUDE.md「用 bun」）。
 * pgvector 以文本字面量写入，drizzle-kit 迁移走自带连接，二者与本文件解耦。
 */
import { drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema'

/** 应用层 DB 句柄类型（供 repository/ 注入，Core 不感知具体驱动）。 */
export type Db = ReturnType<typeof createDb>

/**
 * 建立 Drizzle 连接。bun-sql 惰性连接：调用本函数不立即建连，首个查询时才连。
 * @param url Postgres 连接串（来自注入的 AppConfig.DATABASE_URL，不在此读 env）。
 */
export function createDb(url: string) {
  return drizzle(url, { schema })
}

/** 关闭 Bun SQL 连接池；优雅关闭链路最后调用。 */
export async function closeDb(db: Db): Promise<void> {
  await db.$client.close({ timeout: 1 })
}
