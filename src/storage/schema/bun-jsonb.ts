import { customType } from 'drizzle-orm/pg-core'

/**
 * Bun SQL 会自行序列化 JSONB 参数；不能沿用 Drizzle 内置 jsonb() 的 JSON.stringify，
 * 否则数组/对象会在数据库中变成 JSON 字符串。读取端保留一层旧数据兼容，
 * 0019 迁移会把已持久化的字符串归一化为原生 JSONB。
 */
export function bunJsonb<T>(name: string) {
  return customType<{ data: T; driverData: unknown }>({
    dataType() {
      return 'jsonb'
    },
    fromDriver(value) {
      if (typeof value === 'string') {
        try {
          return JSON.parse(value) as T
        } catch {
          // 非法旧值交给数据库迁移与 CHECK 约束暴露，不在读取层静默改写。
        }
      }
      return value as T
    },
  })(name)
}
