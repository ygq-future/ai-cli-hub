import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MessageRef } from '../shared'

export interface RestartNotice {
  ref: MessageRef
  requestedAt: number
}

export interface RestartNoticeStore {
  write(notice: RestartNotice): Promise<void>
  /** 读取但不删除；仅在消息成功发出后由 clear() 清理，保证失败可重试。 */
  read(): Promise<RestartNotice | null>
  clear(): Promise<void>
  consume(): Promise<RestartNotice | null>
}

export function createRestartNoticeStore(filePath: string): RestartNoticeStore {
  const resolved = path.resolve(filePath)

  return {
    async write(notice) {
      await mkdir(path.dirname(resolved), { recursive: true })
      await writeFile(resolved, JSON.stringify(notice), 'utf8')
    },

    async read() {
      try {
        const raw = await readFile(resolved, 'utf8')
        return parseRestartNotice(raw)
      } catch (err) {
        if (isFileMissing(err)) return null
        throw err
      }
    },

    clear() {
      return rm(resolved, { force: true })
    },

    async consume() {
      const notice = await this.read()
      if (notice) await this.clear()
      return notice
    },
  }
}

function parseRestartNotice(raw: string): RestartNotice | null {
  const parsed = JSON.parse(raw) as Partial<RestartNotice>
  const ref = parsed.ref as Partial<MessageRef> | undefined
  if (
    !ref ||
    (ref.platform !== 'telegram' && ref.platform !== 'qq' && ref.platform !== 'websocket') ||
    typeof ref.chatId !== 'string' ||
    typeof ref.nativeId !== 'string' ||
    typeof parsed.requestedAt !== 'number'
  ) {
    return null
  }
  return {
    ref: { platform: ref.platform, chatId: ref.chatId, nativeId: ref.nativeId },
    requestedAt: parsed.requestedAt,
  }
}

function isFileMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
}
