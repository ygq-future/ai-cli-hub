import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createRestartNoticeStore } from './restart-notification'

describe('restart notice store', () => {
  test('read keeps the marker until it is explicitly cleared', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-restart-notice-'))
    try {
      const store = createRestartNoticeStore(path.join(dir, 'notice.json'))
      await store.write({
        ref: { platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' },
        requestedAt: 1_700_000_000_000,
      })

      expect(await store.read()).toEqual({
        ref: { platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' },
        requestedAt: 1_700_000_000_000,
      })
      expect(await store.read()).toEqual({
        ref: { platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' },
        requestedAt: 1_700_000_000_000,
      })
      await store.clear()
      expect(await store.consume()).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
