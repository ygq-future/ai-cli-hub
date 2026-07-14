import { describe, expect, test } from 'bun:test'
import type { Config, OpencodeClient } from '@opencode-ai/sdk'
import { createOpenCodeServerPool } from './opencode-server-pool'

describe('OpenCodeServerPool', () => {
  test('concurrent adapters share one server and close it after the final lease', async () => {
    let starts = 0
    let closes = 0
    const pool = createOpenCodeServerPool({
      createOpencodeFn: async () => {
        starts += 1
        return {
          client: {} as OpencodeClient,
          server: { url: 'http://127.0.0.1:4096', close: () => void closes++ },
        }
      },
    })

    const config = {} as Config
    const [first, second] = await Promise.all([pool.acquire(config), pool.acquire(config)])
    expect(starts).toBe(1)
    expect(first.client).toBe(second.client)

    await first.release()
    expect(closes).toBe(0)
    await second.release()
    expect(closes).toBe(1)
  })
})
