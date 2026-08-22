import { describe, expect, test } from 'bun:test'
import { createEventBus } from '../event'
import type { ConversationId } from '../shared'
import { createWebAdmin, WebAdminError } from './web-admin'

const conversationId = 'admin-conversation' as ConversationId

function createAdmin() {
  const bus = createEventBus()
  const calls: string[] = []
  const deleted: Array<{ conversationId: ConversationId }> = []
  bus.on('ConversationDeleted', event => deleted.push(event))
  const conversation = {
    id: conversationId,
    platform: 'web',
    userId: 'web-admin',
    cli: 'claude',
    cwd: '/workspace',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3,
    fileCount: 0,
    auditCount: 1,
  }
  const repositories = {
    conversations: {
      async findAdminById() {
        return conversation
      },
      async findById() {
        return conversation
      },
      async deleteAggregate(id: ConversationId) {
        calls.push('delete')
        return {
          conversationId: id,
          managedFilePaths: [],
          deleted: { messages: 3, audits: 1, files: 0 },
        }
      },
      async findLatestOpen() {
        return null
      },
    },
    memories: {
      async findById() {
        return {
          id: 'environment-memory',
          namespace: 'global',
          type: 'semantic',
          content: 'read only',
          embedding: null,
          importance: 1,
          accessCount: 0,
          lastAccessedAt: null,
          tag: 'env.repo',
          createdAt: 1,
        }
      },
    },
    userPreferences: {},
    messages: {},
    conversationFiles: {},
    audit: {},
  }
  const admin = createWebAdmin({
    repos: repositories as never,
    bus,
    preferences: {
      async getCwd() {
        return '/workspace'
      },
      async getModel() {
        return null
      },
      async getTarget() {
        return { cli: 'claude', cwd: '/workspace' }
      },
      async setLanguage() {},
      async setAutoApprove() {},
      async setTarget() {},
      async setModel() {},
    },
    async stopConversation() {
      calls.push('stop')
    },
    async removeManagedFiles() {
      calls.push('remove-files')
    },
    mediaDirectory: '/media',
    async refreshEnvironmentMemories() {},
    async listModels() {
      return []
    },
    async setModel() {
      return 'model'
    },
    resolveCwd: raw => ({ ok: true, cwd: raw }),
  })
  return { admin, calls, deleted }
}

describe('web admin', () => {
  test('删除会话先停止运行时，再删除聚合并发布删除事件', async () => {
    const { admin, calls, deleted } = createAdmin()

    await expect(admin.deleteConversation(conversationId)).resolves.toEqual({
      conversationId,
      managedFilePaths: [],
      deleted: { messages: 3, audits: 1, files: 0 },
      fileCleanupWarnings: [],
    })
    expect(calls).toEqual(['stop', 'delete'])
    expect(deleted).toEqual([{ conversationId }])
  })

  test('环境快照记忆不可由 Web 管理面修改或删除', async () => {
    const { admin } = createAdmin()

    await expect(admin.updateMemory('environment-memory', { content: 'changed' })).rejects.toEqual(
      new WebAdminError('forbidden', 'Environment memories are read-only'),
    )
    await expect(admin.deleteMemory('environment-memory')).resolves.toBe('read_only')
  })
})
