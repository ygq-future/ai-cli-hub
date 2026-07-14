/** 会话文件生命周期：订阅清空/关闭事件，删除映射与受控媒体目录中的临时文件。 */
import path from 'node:path'
import { unlink } from 'node:fs/promises'
import type { EventBus } from '../event'
import type { Repositories } from '../repository'
import type { ConversationId, Unsubscribe } from '../shared'

export interface ConversationFileLifecycle {
  clear(conversationId: ConversationId): Promise<void>
  destroy(): void
}

export interface ConversationFileLifecycleOptions {
  bus: EventBus
  repos: Repositories
  mediaDirectory: string
}

export function createConversationFileLifecycle(options: ConversationFileLifecycleOptions): ConversationFileLifecycle {
  const mediaDirectory = path.resolve(options.mediaDirectory)
  const unsubs: Unsubscribe[] = [
    options.bus.on('ConversationCleared', payload => {
      void clearConversationFiles(payload.conversationId, true)
    }),
    options.bus.on('SessionClosed', payload => {
      void clearConversationFiles(payload.conversationId, true)
    }),
  ]

  async function clearConversationFiles(conversationId: ConversationId, reportError = false): Promise<void> {
    try {
      const files = await options.repos.conversationFiles.deleteByConversation(conversationId)
      await Promise.all(files.map(file => removeManagedFile(file.localPath)))
    } catch (err) {
      if (reportError) {
        options.bus.emit('ErrorOccurred', {
          scope: 'media:conversationFileCleanup',
          conversationId,
          message: err instanceof Error ? err.message : String(err),
        })
        return
      }
      throw err
    }
  }

  async function removeManagedFile(localPath: string): Promise<void> {
    const resolved = path.resolve(localPath)
    const relative = path.relative(mediaDirectory, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Refusing to delete file outside MEDIA_DOWNLOAD_DIR: ${resolved}`)
    }
    try {
      await unlink(resolved)
    } catch (err) {
      if (isMissingFileError(err)) return
      throw err
    }
  }

  return {
    clear: conversationId => clearConversationFiles(conversationId),
    destroy() {
      for (const unsub of unsubs) unsub()
      unsubs.length = 0
    },
  }
}

function isMissingFileError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')
}
