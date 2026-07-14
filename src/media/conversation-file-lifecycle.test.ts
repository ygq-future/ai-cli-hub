import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '../event'
import type { ConversationId } from '../shared'
import { createConversationFileLifecycle } from './conversation-file-lifecycle'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('conversation file lifecycle', () => {
  test('clear 等待删除数据库映射和受控目录中的文件', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-files-'))
    temporaryDirectories.push(directory)
    const localPath = path.join(directory, 'document.txt')
    await writeFile(localPath, 'hello')
    let deleted = false
    const lifecycle = createConversationFileLifecycle({
      bus: createEventBus(),
      repos: {
        conversationFiles: {
          async deleteByConversation() {
            deleted = true
            return [{ localPath }]
          },
        },
      } as never,
      mediaDirectory: directory,
    })

    await lifecycle.clear('conversation-1' as ConversationId)

    expect(deleted).toBe(true)
    expect(await Bun.file(localPath).exists()).toBe(false)
    lifecycle.destroy()
  })

  test('拒绝删除媒体目录之外的路径', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-files-'))
    const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-outside-'))
    temporaryDirectories.push(directory, outsideDirectory)
    const outsidePath = path.join(outsideDirectory, 'keep.txt')
    await writeFile(outsidePath, 'keep')
    const lifecycle = createConversationFileLifecycle({
      bus: createEventBus(),
      repos: {
        conversationFiles: {
          async deleteByConversation() {
            return [{ localPath: outsidePath }]
          },
        },
      } as never,
      mediaDirectory: directory,
    })

    await expect(lifecycle.clear('conversation-1' as ConversationId)).rejects.toThrow('outside MEDIA_DOWNLOAD_DIR')
    expect(await Bun.file(outsidePath).exists()).toBe(true)
    lifecycle.destroy()
  })
})
