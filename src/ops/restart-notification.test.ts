import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createRestartNoticeStore } from './restart-notification'

describe('restart notice store', () => {
  test('write then consume once', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-restart-notice-'))
    try {
      const store = createRestartNoticeStore(path.join(dir, 'notice.json'))
      await store.write({
        ref: { platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' },
        requestedAt: 1_700_000_000_000,
      })

      expect(await store.consume()).toEqual({
        ref: { platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' },
        requestedAt: 1_700_000_000_000,
      })
      expect(await store.consume()).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
