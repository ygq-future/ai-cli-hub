import path from 'node:path'
import type { EventBus } from '../event'
import type { Repositories } from '../repository'
import type { UserLanguage } from '../shared'
import {
  DEFAULT_MEMORY_NAMESPACE,
  MAX_AUTO_APPROVE_SECONDS,
  MIN_AUTO_APPROVE_SECONDS,
  type AuditListQuery,
  type AuditPage,
  type AuditView,
  type CliPreferenceView,
  type CliType,
  type ConversationFilePage,
  type ConversationFileView,
  type ConversationId,
  type ConversationListQuery,
  type ConversationView,
  type CursorPosition,
  type MemoryListQuery,
  type MemoryPage,
  type MemoryUpdate,
  type MemoryView,
  type PreferenceScope,
  type PreferenceScopePage,
  type PreferenceSnapshot,
  type TimelinePage,
  type WebAdmin,
} from '../shared'
import { hydrateTimeline } from './timeline'

export type WebAdminErrorCode = 'bad_request' | 'not_found' | 'conflict' | 'forbidden'

export class WebAdminError extends Error {
  constructor(
    readonly code: WebAdminErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WebAdminError'
  }
}

export interface WebAdminPreferenceOps {
  getCwd(platform: PreferenceScope['platform'], userId: string, cli: CliType): Promise<string>
  getModel(
    platform: PreferenceScope['platform'],
    userId: string,
    cli: CliType,
  ): Promise<{ modelId: string; modelName: string } | null>
  getTarget(platform: PreferenceScope['platform'], userId: string): Promise<{ cli: CliType; cwd: string }>
  setLanguage(platform: PreferenceScope['platform'], userId: string, language: UserLanguage): Promise<void>
  setAutoApprove(
    platform: PreferenceScope['platform'],
    userId: string,
    preference: { enabled: boolean; seconds: number },
  ): Promise<void>
  setTarget(platform: PreferenceScope['platform'], userId: string, target: { cli: CliType; cwd: string }): Promise<void>
  setModel(
    platform: PreferenceScope['platform'],
    userId: string,
    cli: CliType,
    model: { modelId: string; modelName: string },
  ): Promise<void>
}

export interface WebAdminDeps {
  repos: Repositories
  bus: EventBus
  preferences: WebAdminPreferenceOps
  stopConversation(conversationId: ConversationId): Promise<void>
  removeManagedFiles(localPaths: readonly string[]): Promise<void>
  mediaDirectory: string
  refreshEnvironmentMemories(): Promise<void>
  listModels(conversationId: ConversationId): Promise<Array<{ id: string; name: string }>>
  setModel(conversationId: ConversationId, modelId: string): Promise<string>
  resolveCwd(raw: string): { ok: true; cwd: string } | { ok: false; message: string }
  namespace?: string
}

const SUPPORTED_CLI_TYPES: readonly CliType[] = ['claude', 'opencode']

export function createWebAdmin(deps: WebAdminDeps): WebAdmin {
  const namespace = deps.namespace ?? DEFAULT_MEMORY_NAMESPACE
  const mediaDirectory = path.resolve(deps.mediaDirectory)

  function requireConversationId(id: ConversationId): string {
    if (!id || !id.trim()) throw new WebAdminError('bad_request', 'conversationId is required')
    return id
  }

  async function getConversationOrThrow(id: ConversationId) {
    requireConversationId(id)
    const conversation = await deps.repos.conversations.findAdminById(id)
    if (!conversation) throw new WebAdminError('not_found', 'Conversation not found')
    return conversation
  }

  async function getPreferenceOrThrow(scope: PreferenceScope) {
    const preference = await deps.repos.userPreferences.find(scope.platform, scope.userId)
    if (!preference) throw new WebAdminError('not_found', 'Preference scope not found')
    return preference
  }

  async function preferenceSnapshot(scope: PreferenceScope): Promise<PreferenceSnapshot> {
    const preference = await getPreferenceOrThrow(scope)
    const existing = new Map(
      (await deps.repos.userPreferences.listCliPreferences(scope.platform, scope.userId)).map(item => [item.cli, item]),
    )
    const cli = await Promise.all(
      SUPPORTED_CLI_TYPES.map(async cliType => {
        const item = existing.get(cliType)
        const cwd = item?.cwd ?? (await deps.preferences.getCwd(scope.platform, scope.userId, cliType))
        return {
          cli: cliType,
          cwd,
          modelId: item?.modelId ?? null,
          modelName: item?.modelName ?? null,
        }
      }),
    )
    return {
      scope,
      language: preference.language as UserLanguage,
      defaultCli: preference.defaultCli as CliType,
      autoApproveEnabled: preference.autoApproveEnabled,
      autoApproveSeconds: preference.autoApproveSeconds,
      cli,
      updatedAt: preference.updatedAt,
    }
  }

  return {
    async listConversations(query: ConversationListQuery) {
      const page = await deps.repos.conversations.listAdminPage(query)
      return {
        items: page.items.map(toConversationView),
        nextCursor: encodeCursor(page.nextCursor),
      }
    },

    async getConversation(id) {
      const conversation = await deps.repos.conversations.findAdminById(id)
      return conversation ? toConversationView(conversation) : null
    },

    async getConversationTimeline(id, page): Promise<TimelinePage | null> {
      const conversation = await deps.repos.conversations.findById(id)
      if (!conversation) return null
      const messages = await deps.repos.messages.listByConversation(
        id,
        page.limit + 1,
        page.before ? { createdAt: page.before.timestamp, id: page.before.id } : undefined,
      )
      const hasMore = messages.length > page.limit
      const pageMessages = hasMore ? messages.slice(-page.limit) : messages
      const auditIds = pageMessages.flatMap(message =>
        message.messageType === 'approval' && message.auditLogId ? [message.auditLogId] : [],
      )
      const audits = await deps.repos.audit.findByIds(auditIds)
      const items = hydrateTimeline(pageMessages, audits)
      const first = pageMessages[0]
      return {
        items,
        nextCursor: hasMore && first ? encodeCursor({ timestamp: first.createdAt, id: first.id }) : null,
      }
    },

    async getConversationFiles(id, page): Promise<ConversationFilePage | null> {
      const conversation = await deps.repos.conversations.findById(id)
      if (!conversation) return null
      const result = await deps.repos.conversationFiles.listPage(id, {
        ...page,
        before: page.before ? { timestamp: page.before.timestamp, id: page.before.id } : undefined,
      })
      return {
        items: result.items.map(toConversationFileView),
        nextCursor: encodeCursor(result.nextCursor),
      }
    },

    async getConversationFile(id, fileId) {
      const record = await deps.repos.conversationFiles.findById(id, fileId)
      if (!record || !isManagedPath(record.localPath, mediaDirectory)) return null
      const body = Bun.file(record.localPath)
      if (!(await body.exists())) return null
      return { body, fileName: record.fileName, mimeType: record.mimeType }
    },

    async deleteConversation(id) {
      requireConversationId(id)
      await getConversationOrThrow(id)
      await deps.stopConversation(id)
      const aggregate = await deps.repos.conversations.deleteAggregate(id)
      if (!aggregate) return null
      const warnings: string[] = []
      if (aggregate.managedFilePaths.length) {
        try {
          await deps.removeManagedFiles(aggregate.managedFilePaths)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          warnings.push(message)
          deps.bus.emit('ErrorOccurred', {
            scope: 'web-admin:conversation-file-delete',
            conversationId: id,
            message,
          })
        }
      }
      deps.bus.emit('ConversationDeleted', { conversationId: id })
      return { ...aggregate, fileCleanupWarnings: warnings }
    },

    async listPreferenceScopes(query): Promise<PreferenceScopePage> {
      const page = await deps.repos.userPreferences.listScopes(query)
      return {
        items: page.items.map(item => ({
          platform: item.platform,
          userId: item.userId,
          defaultCli: item.defaultCli,
          updatedAt: item.updatedAt,
        })),
        nextCursor: encodeCursor(page.nextCursor),
      }
    },

    getPreferences: preferenceSnapshot,

    async updatePreferences(scope, input): Promise<PreferenceSnapshot> {
      const current = await getPreferenceOrThrow(scope)
      if (input.language !== undefined) await deps.preferences.setLanguage(scope.platform, scope.userId, input.language)
      if (input.autoApproveEnabled !== undefined || input.autoApproveSeconds !== undefined) {
        const seconds = input.autoApproveSeconds ?? current.autoApproveSeconds
        if (seconds < MIN_AUTO_APPROVE_SECONDS || seconds > MAX_AUTO_APPROVE_SECONDS)
          throw new WebAdminError(
            'bad_request',
            `autoApproveSeconds must be ${MIN_AUTO_APPROVE_SECONDS}-${MAX_AUTO_APPROVE_SECONDS}`,
          )
        await deps.preferences.setAutoApprove(scope.platform, scope.userId, {
          enabled: input.autoApproveEnabled ?? current.autoApproveEnabled,
          seconds,
        })
      }
      if (input.defaultCli !== undefined && input.defaultCli !== current.defaultCli) {
        const cwd = await deps.preferences.getCwd(scope.platform, scope.userId, input.defaultCli)
        await deps.preferences.setTarget(scope.platform, scope.userId, { cli: input.defaultCli, cwd })
      }
      return preferenceSnapshot(scope)
    },

    async updateCliPreference(scope, cli, input): Promise<CliPreferenceView> {
      if (!SUPPORTED_CLI_TYPES.includes(cli)) throw new WebAdminError('bad_request', `Unsupported CLI: ${cli}`)
      const current = await deps.repos.userPreferences.findCliPreference(scope.platform, scope.userId, cli)
      let cwd = current?.cwd ?? (await deps.preferences.getCwd(scope.platform, scope.userId, cli))
      if (input.cwd !== undefined) {
        const resolved = deps.resolveCwd(input.cwd)
        if (!resolved.ok) throw new WebAdminError('bad_request', resolved.message)
        const open = await deps.repos.conversations.findLatestOpen(scope.platform, scope.userId, cli)
        if (open && open.cwd !== resolved.cwd)
          throw new WebAdminError('conflict', 'An open conversation uses another cwd')
        cwd = resolved.cwd
        await deps.repos.userPreferences.upsertCwd(scope.platform, scope.userId, cli, cwd)
        const target = await deps.preferences.getTarget(scope.platform, scope.userId)
        if (target.cli === cli) await deps.preferences.setTarget(scope.platform, scope.userId, { cli, cwd })
      }

      let modelId = current?.modelId ?? null
      let modelName = current?.modelName ?? null
      if (input.modelId !== undefined) {
        if (input.modelId === null) {
          await deps.repos.userPreferences.setModel(scope.platform, scope.userId, cli, null, null)
          modelId = null
          modelName = null
        } else {
          const open = await deps.repos.conversations.findLatestOpen(scope.platform, scope.userId, cli)
          if (!open) throw new WebAdminError('conflict', 'An open conversation is required to select a model')
          const models = await deps.listModels(open.id as ConversationId)
          const model = models.find(item => item.id === input.modelId)
          if (!model) throw new WebAdminError('bad_request', `Unknown model: ${input.modelId}`)
          const selected = await deps.setModel(open.id as ConversationId, model.id)
          await deps.preferences.setModel(scope.platform, scope.userId, cli, {
            modelId: selected,
            modelName: model.name,
          })
          modelId = selected
          modelName = model.name
        }
      }
      return { cli, cwd, modelId, modelName }
    },

    async listMemories(query: MemoryListQuery): Promise<MemoryPage> {
      const page = await deps.repos.memories.listPage({ ...query, namespace })
      return { items: page.items.map(toMemoryView), nextCursor: encodeCursor(page.nextCursor) }
    },

    async updateMemory(id: string, input: MemoryUpdate): Promise<MemoryView | null> {
      const current = await deps.repos.memories.findById(id)
      if (!current) return null
      if (isEnvironmentMemory(current.tag)) throw new WebAdminError('forbidden', 'Environment memories are read-only')
      const updated = await deps.repos.memories.update(id, input)
      if (!updated) return null
      deps.bus.emit('MemoryUpdated', { namespace: updated.namespace, memoryType: updated.type, memoryId: updated.id })
      return toMemoryView(updated)
    },

    async deleteMemory(id: string) {
      const current = await deps.repos.memories.findById(id)
      if (!current) return 'not_found' as const
      if (isEnvironmentMemory(current.tag)) return 'read_only' as const
      await deps.repos.memories.delete(id)
      deps.bus.emit('MemoryUpdated', { namespace: current.namespace, memoryType: current.type, memoryId: id })
      return 'deleted' as const
    },

    async refreshEnvironmentMemories() {
      await deps.refreshEnvironmentMemories()
    },

    async listAudits(query: AuditListQuery): Promise<AuditPage> {
      const page = await deps.repos.audit.listAdminPage(query)
      return { items: page.items.map(toAuditView), nextCursor: encodeCursor(page.nextCursor) }
    },
  }
}

function toConversationView(value: {
  id: string
  platform: ConversationView['platform']
  userId: string
  cli: CliType
  cwd: string
  status: ConversationView['status']
  createdAt: number
  updatedAt: number
  messageCount: number
  fileCount: number
  auditCount: number
}): ConversationView {
  return { ...value, id: value.id as ConversationId }
}

function toConversationFileView(value: {
  id: string
  sequence: number
  kind: string
  fileName: string | null
  mimeType: string | null
  fileSize: number | null
  createdAt: number
}): ConversationFileView {
  return value
}

function toMemoryView(value: {
  id: string
  namespace: string
  type: MemoryView['type']
  content: string
  importance: number
  accessCount: number
  lastAccessedAt: number | null
  tag: string | null
  createdAt: number
  embedding: number[] | null
}): MemoryView {
  return { ...value, embeddingPresent: value.embedding !== null }
}

function toAuditView(value: {
  id: string
  conversationId: string
  platform: AuditView['platform']
  userId: string
  cli: CliType
  cwd: string
  approvalId: string
  request: AuditView['request']
  status: AuditView['status']
  operator: string | null
  automatic: boolean
  createdAt: number
}): AuditView {
  return { ...value, conversationId: value.conversationId as ConversationId }
}

function encodeCursor(cursor: CursorPosition | null): string | null {
  return cursor ? `${cursor.timestamp}:${encodeURIComponent(cursor.id)}` : null
}

function isEnvironmentMemory(tag: string | null): boolean {
  return tag?.startsWith('env.') === true
}

function isManagedPath(localPath: string, mediaDirectory: string): boolean {
  const resolved = path.resolve(localPath)
  const relative = path.relative(mediaDirectory, resolved)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}
