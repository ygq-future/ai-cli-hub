import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MessageRef } from '../shared'

export interface RestartNotice {
  ref: MessageRef
  requestedAt: number
}

export interface RestartNoticeStore {
  write(notice: RestartNotice): Promise<void>
  consume(): Promise<RestartNotice | null>
}

export function createRestartNoticeStore(filePath: string): RestartNoticeStore {
  const resolved = path.resolve(filePath)

  return {
    async write(notice) {
      await mkdir(path.dirname(resolved), { recursive: true })
      await writeFile(resolved, JSON.stringify(notice), 'utf8')
    },

    async consume() {
      try {
        const raw = await readFile(resolved, 'utf8')
        await rm(resolved, { force: true })
        return parseRestartNotice(raw)
      } catch (err) {
        if (isFileMissing(err)) return null
        throw err
      }
    },
  }
}

function parseRestartNotice(raw: string): RestartNotice | null {
  const parsed = JSON.parse(raw) as Partial<RestartNotice>
  const ref = parsed.ref as Partial<MessageRef> | undefined
  if (
    !ref ||
    ref.platform !== 'telegram' ||
    typeof ref.chatId !== 'string' ||
    typeof ref.nativeId !== 'string' ||
    typeof parsed.requestedAt !== 'number'
  ) {
    return null
  }
  return { ref: { platform: 'telegram', chatId: ref.chatId, nativeId: ref.nativeId }, requestedAt: parsed.requestedAt }
}

function isFileMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
}
