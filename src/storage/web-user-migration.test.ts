import { describe, expect, test } from 'bun:test'
import type { Db } from './db'
import { migrateWebUserIdentity } from './web-user-migration'

type MigrationOptions = { hasLegacyRows: boolean; hasConflict?: boolean }

function createFakeDb(options: MigrationOptions): { db: Db; calls: number } {
  let calls = 0
  const tx = {
    async execute<T>(): Promise<T[]> {
      calls += 1
      if (calls === 1) return [{ exists: options.hasLegacyRows }] as T[]
      if (calls === 2 && options.hasConflict) return [{ cli: 'claude' }] as T[]
      return [] as T[]
    },
  }
  const db = {
    transaction<T>(callback: (transaction: typeof tx) => Promise<T>): Promise<T> {
      return callback(tx)
    },
  } as unknown as Db
  return {
    db,
    get calls() {
      return calls
    },
  }
}

describe('migrateWebUserIdentity', () => {
  test('没有旧 Web 数据时保持幂等且不执行写入', async () => {
    const fake = createFakeDb({ hasLegacyRows: false })

    await expect(migrateWebUserIdentity(fake.db, 'web-admin')).resolves.toEqual({
      changed: false,
      userId: 'web-admin',
    })
    expect(fake.calls).toBe(1)
  })

  test('将旧 Web 身份迁移到稳定目标值', async () => {
    const fake = createFakeDb({ hasLegacyRows: true })

    await expect(migrateWebUserIdentity(fake.db, ' web-admin ')).resolves.toEqual({
      changed: true,
      userId: 'web-admin',
    })
    expect(fake.calls).toBeGreaterThan(2)
  })

  test('存在同 CLI 未关闭会话冲突时拒绝迁移', async () => {
    const fake = createFakeDb({ hasLegacyRows: true, hasConflict: true })

    await expect(migrateWebUserIdentity(fake.db, 'web-admin')).rejects.toThrow(/open Web conversation/)
    expect(fake.calls).toBe(2)
  })

  test('拒绝空稳定身份', async () => {
    const fake = createFakeDb({ hasLegacyRows: false })

    await expect(migrateWebUserIdentity(fake.db, '  ')).rejects.toThrow(/must not be empty/)
    expect(fake.calls).toBe(0)
  })
})
