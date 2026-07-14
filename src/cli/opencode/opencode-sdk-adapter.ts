/**
 * OpenCodeSdkAdapter —— SDK 家族，实现 CLIAdapter（D11）。
 *
 * @opencode-ai/sdk 会拉起本机 `opencode serve`，再通过 HTTP/SSE client 操作 session。
 * 输出来自 message.part.updated，审批来自 permission.asked。
 */
import type { Config, OpencodeClient } from '@opencode-ai/sdk'
import type { CliType } from '../../shared'
import type {
  AdapterState,
  ApprovalAction,
  ApprovalRequest,
  CliModel,
  CLIAdapter,
  ExitInfo,
  OutputDelta,
  SpawnOptions,
} from '../base'
import { EMPTY_VISIBLE_RESULT_MESSAGE } from '../constants'
import { sanitizeVisibleText } from '../format-output'
import {
  buildSystemPromptAppend,
  emitHandlers,
  isReadOnlyShellCommand,
  isReadOnlyToolName,
  unsubscribeHandler,
} from '../utils'
import {
  createOpenCodeServerPool,
  type CreateOpenCodeFn,
  type OpenCodeServerLease,
  type OpenCodeServerPool,
} from './opencode-server-pool'

type StartedOpenCode = OpenCodeServerLease

interface OpenCodeEventEnvelope {
  directory?: string
  payload: unknown
}

interface PendingOpenCodePermission {
  id: string
  sessionID: string
}

export interface OpenCodeSdkAdapterDeps {
  createOpencodeFn?: CreateOpenCodeFn
  serverPool?: OpenCodeServerPool
  debugRawJson?: boolean
  rawMessageLogger?: (rawJson: string) => void
}

export function createOpenCodeSdkAdapter(deps?: OpenCodeSdkAdapterDeps): CLIAdapter {
  const serverPool = deps?.serverPool ?? createOpenCodeServerPool({ createOpencodeFn: deps?.createOpencodeFn })
  const debugRawJson = deps?.debugRawJson ?? false
  const rawMessageLogger = deps?.rawMessageLogger
  const cliType: CliType = 'opencode'

  let state: AdapterState = 'stopped'
  let started: StartedOpenCode | null = null
  let sessionId: string | null = null
  let cwd = ''
  let systemPrompt = ''
  let modelId: string | null = null
  let abortController: AbortController | null = null
  let eventTask: Promise<void> | null = null
  let turnHasInput = false
  let turnHasVisibleText = false

  const outputHandlers: Array<(d: OutputDelta) => void> = []
  const approvalHandlers: Array<(r: ApprovalRequest) => void> = []
  const exitHandlers: Array<(i: ExitInfo) => void> = []
  const textParts = new Map<string, string>()
  const messageRoles = new Map<string, 'user' | 'assistant'>()
  const pendingApprovals = new Map<string, PendingOpenCodePermission>()

  function emitRaw(value: unknown) {
    if (!debugRawJson) return
    try {
      rawMessageLogger?.(JSON.stringify(value))
    } catch {
      rawMessageLogger?.(String(value))
    }
  }

  function currentSession(): string {
    if (!sessionId) throw new Error('OpenCodeSdkAdapter: session is not ready')
    return sessionId
  }

  function currentClient(): OpencodeClient {
    if (!started) throw new Error('OpenCodeSdkAdapter: client is not ready')
    return started.client
  }

  function emitRawEvent(type: string, event: OpenCodeEventEnvelope) {
    if (!shouldLogRawEvent(type, event.payload)) return
    emitRaw(redactRawEvent(type, event))
  }

  function handleEvent(event: OpenCodeEventEnvelope) {
    if (event.directory && normalizePath(event.directory) !== normalizePath(cwd)) return

    const payload = asRecord(event.payload)
    if (!payload) return
    const type = readString(payload, 'type')
    if (!type) return
    emitRawEvent(type, event)

    const properties = asRecord(payload.properties)
    if (!properties) return

    switch (type) {
      case 'server.heartbeat':
      case 'message.part.delta':
      case 'permission.replied':
        return
      case 'message.updated': {
        const info = asRecord(properties.info)
        if (!info || readString(info, 'sessionID') !== sessionId) return
        const messageId = readString(info, 'id')
        const role = readMessageRole(info)
        if (messageId && role) messageRoles.set(messageId, role)
        return
      }
      case 'message.removed': {
        if (readString(properties, 'sessionID') !== sessionId) return
        const messageId = readString(properties, 'messageID')
        if (messageId) messageRoles.delete(messageId)
        return
      }
      case 'message.part.updated': {
        const part = asRecord(properties.part)
        if (!part || readString(part, 'sessionID') !== sessionId) return
        const messageId = readString(part, 'messageID')
        if (!messageId || messageRoles.get(messageId) !== 'assistant') return
        const partType = readString(part, 'type')
        if (partType === 'text') {
          const partId = readString(part, 'id')
          const text = readString(part, 'text')
          if (partId && typeof text === 'string') handleTextPart(partId, text)
        } else if (partType === 'tool') {
          const state = asRecord(part.state)
          handleToolPart(readString(part, 'tool') ?? 'tool', asRecord(state?.input) ?? {})
        }
        return
      }
      case 'permission.asked':
      case 'permission.updated': {
        const permission = parsePermission(properties)
        if (!permission || permission.sessionID !== sessionId) return
        pendingApprovals.set(permission.id, { id: permission.id, sessionID: permission.sessionID })
        if (isReadOnlyPermission(properties)) {
          state = 'busy'
          void replyPermission(permission, 'once')
            .then(() => pendingApprovals.delete(permission.id))
            .catch(() => {
              if (!pendingApprovals.has(permission.id)) return
              state = 'waitingApproval'
              emitHandlers(approvalHandlers, permissionToApproval(properties))
            })
          return
        }
        state = 'waitingApproval'
        emitHandlers(approvalHandlers, permissionToApproval(properties))
        return
      }
      case 'session.idle': {
        if (readString(properties, 'sessionID') !== sessionId) return
        finishTurn()
        return
      }
      case 'session.status': {
        if (readString(properties, 'sessionID') !== sessionId) return
        const status = asRecord(properties.status)
        const statusType = readString(status ?? {}, 'type')
        if (statusType === 'idle') finishTurn()
        else if (statusType === 'busy' || statusType === 'retry') state = 'busy'
        return
      }
      case 'session.error': {
        const eventSessionId = readString(properties, 'sessionID')
        if (eventSessionId && eventSessionId !== sessionId) return
        finishTurn(formatSessionError(properties.error))
        return
      }
    }
  }

  function finishTurn(errorText?: string) {
    if (!turnHasInput) return
    const text = errorText ?? (turnHasVisibleText ? '' : EMPTY_VISIBLE_RESULT_MESSAGE)
    emitHandlers(outputHandlers, { kind: 'text', text, final: true })
    turnHasInput = false
    turnHasVisibleText = false
    state = 'ready'
  }

  function handleTextPart(partId: string, text: string) {
    const previous = textParts.get(partId) ?? ''
    textParts.set(partId, text)
    const chunk = text.slice(previous.length)
    const visible = sanitizeVisibleText(chunk)
    if (!visible) return
    turnHasVisibleText = true
    emitHandlers(outputHandlers, { kind: 'text', text: visible, final: false })
  }

  function handleToolPart(toolName: string, toolInput: Record<string, unknown>) {
    emitHandlers(outputHandlers, { kind: 'tool_use', text: '', final: false, toolName, toolInput })
  }

  function permissionToApproval(permission: Record<string, unknown>): ApprovalRequest {
    // 官方类型：新版 permission.asked 有 permission 字段（bash/edit/glob…），旧版用 type
    const perm = readString(permission, 'permission') ?? readString(permission, 'type') ?? 'permission'
    const meta = asRecord(permission.metadata) ?? {}
    // 优先用 title（旧版），否则 bash 时从 metadata.command 提取标题
    const command =
      readString(permission, 'title') ?? (perm === 'bash' ? readString(meta, 'command') : undefined) ?? perm
    return {
      approvalId: readString(permission, 'id') ?? '',
      command,
      detail: JSON.stringify({
        permission: perm,
        patterns: permission.patterns,
        metadata: permission.metadata,
        tool: permission.tool,
        always: permission.always,
      }),
    }
  }

  async function replyPermission(permission: PendingOpenCodePermission, response: 'once' | 'reject'): Promise<void> {
    if (!started) throw new Error('OpenCodeSdkAdapter: client is not ready')
    const result = await started.client.postSessionIdPermissionsPermissionId({
      path: { id: permission.sessionID, permissionID: permission.id },
      query: { directory: cwd },
      body: { response },
    })
    if (result.error) throw new Error(formatError(result.error))
  }

  async function listAvailableModels(): Promise<CliModel[]> {
    const result = await currentClient().provider.list({ query: { directory: cwd } })
    if (result.error) throw new Error(formatError(result.error))
    if (!result.data) throw new Error('OpenCodeSdkAdapter: provider list returned no data')
    const connected = new Set(result.data.connected)
    return result.data.all
      .filter(provider => connected.has(provider.id))
      .flatMap(provider =>
        Object.values(provider.models).map(model => ({
          id: `${provider.id}/${model.id}`,
          name: `${provider.name} · ${model.name}`,
          description: `${model.limit.context} context · ${model.limit.output} max output`,
        })),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  async function listenForEvents(client: OpencodeClient, signal: AbortSignal) {
    try {
      const events = await client.event.subscribe({ query: { directory: cwd }, signal })
      for await (const event of events.stream) {
        if (signal.aborted) return
        handleEvent({ directory: cwd, payload: event })
      }
      emitHandlers(exitHandlers, { code: 0, reason: 'stop' })
    } catch {
      if (signal.aborted) return
      emitHandlers(exitHandlers, { code: 1, reason: 'crash' })
    } finally {
      if (!signal.aborted) {
        const active = started
        started = null
        sessionId = null
        state = 'stopped'
        await active?.release()
      }
    }
  }

  return {
    cliType,

    async start(opts: SpawnOptions) {
      if (started) throw new Error('OpenCodeSdkAdapter: already started')
      state = 'starting'
      cwd = opts.cwd
      textParts.clear()
      messageRoles.clear()
      pendingApprovals.clear()
      turnHasInput = false
      turnHasVisibleText = false
      abortController = new AbortController()

      systemPrompt = buildSystemPromptAppend(opts.systemLanguageHint)
      modelId = opts.modelId ?? null
      const instance = await serverPool.acquire(buildOpenCodeConfig())
      started = instance

      try {
        const created = await instance.client.session.create({ query: { directory: cwd } })
        if (created.error)
          throw new Error(`OpenCodeSdkAdapter: failed to create session: ${formatError(created.error)}`)
        sessionId = created.data.id
      } catch (err) {
        started = null
        await instance.release()
        throw err
      }

      eventTask = listenForEvents(instance.client, abortController.signal)
      state = 'ready'
    },

    async stop() {
      const client = started?.client
      const sid = sessionId
      abortController?.abort()
      abortController = null
      if (client && sid) await client.session.abort({ path: { id: sid }, query: { directory: cwd } }).catch(() => {})
      const active = started
      started = null
      sessionId = null
      state = 'stopped'
      await active?.release()
      await eventTask?.catch(() => {})
      eventTask = null
    },

    interrupt() {
      const client = started?.client
      const sid = sessionId
      if (!client || !sid) return
      void client.session.abort({ path: { id: sid }, query: { directory: cwd } }).catch(() => {})
    },

    async sendContext(text: string) {
      const client = currentClient()
      const sid = currentSession()
      const result = await client.session.prompt({
        path: { id: sid },
        query: { directory: cwd },
        body: { noReply: true, parts: [{ type: 'text', text }] },
      })
      if (result.error) throw new Error(formatError(result.error))
    },

    sendUserInput(text: string) {
      const client = currentClient()
      const sid = currentSession()
      turnHasInput = true
      turnHasVisibleText = false
      state = 'busy'
      void client.session
        .promptAsync({
          path: { id: sid },
          query: { directory: cwd },
          body: {
            agent: 'ai_cli_hub',
            system: systemPrompt,
            ...(modelId ? { model: parseOpenCodeModelId(modelId) } : {}),
            parts: [{ type: 'text', text }],
          },
        })
        .then(result => {
          if (result.error) throw new Error(formatError(result.error))
        })
        .catch(err => {
          finishTurn(formatError(err))
        })
    },

    resolveApproval(approvalId: string, decision: ApprovalAction) {
      const permission = pendingApprovals.get(approvalId)
      if (!permission || !started) return
      pendingApprovals.delete(approvalId)
      state = 'busy'
      void replyPermission(permission, decision === 'approve' ? 'once' : 'reject').catch(err => {
        finishTurn(formatError(err))
      })
    },

    async listModels(): Promise<CliModel[]> {
      return listAvailableModels()
    },

    async setModel(nextModelId: string): Promise<string> {
      const models = await listAvailableModels()
      const selected = models.find(model => model.id === nextModelId)
      if (!selected) throw new Error(`OpenCodeSdkAdapter: model is not available: ${nextModelId}`)
      modelId = selected.id
      return selected.id
    },

    onOutput(handler) {
      outputHandlers.push(handler)
      return unsubscribeHandler(outputHandlers, handler)
    },
    onApprovalRequest(handler) {
      approvalHandlers.push(handler)
      return unsubscribeHandler(approvalHandlers, handler)
    },
    onExit(handler) {
      exitHandlers.push(handler)
      return unsubscribeHandler(exitHandlers, handler)
    },

    getState: () => state,
  }
}

function parseOpenCodeModelId(modelId: string): { providerID: string; modelID: string } {
  const separator = modelId.indexOf('/')
  if (separator <= 0 || separator === modelId.length - 1) {
    throw new Error(`OpenCodeSdkAdapter: invalid model ID: ${modelId}; expected provider/model`)
  }
  return { providerID: modelId.slice(0, separator), modelID: modelId.slice(separator + 1) }
}

function buildOpenCodeConfig(): Config {
  return {
    permission: {
      edit: 'ask',
      bash: 'ask',
      webfetch: 'ask',
      doom_loop: 'ask',
      external_directory: 'ask',
    },
    instructions: [],
    agent: {
      ai_cli_hub: {
        mode: 'primary',
        prompt: '',
        permission: {
          edit: 'ask',
          bash: 'ask',
          webfetch: 'ask',
          doom_loop: 'ask',
          external_directory: 'ask',
        },
      },
    },
  }
}

function parsePermission(value: Record<string, unknown>): PendingOpenCodePermission | null {
  const id = readString(value, 'id')
  const sessionID = readString(value, 'sessionID')
  if (!id || !sessionID) return null
  return { id, sessionID }
}

function isReadOnlyPermission(value: Record<string, unknown>): boolean {
  const permission = readString(value, 'permission') ?? readString(value, 'type')
  if (!permission) return false
  if (isReadOnlyToolName(permission)) return true
  if (permission !== 'bash') return false
  const metadata = asRecord(value.metadata)
  const command = metadata ? readString(metadata, 'command') : undefined
  return typeof command === 'string' && isReadOnlyShellCommand(command)
}

function shouldLogRawEvent(type: string, payload: unknown): boolean {
  if (ACTIONABLE_RAW_EVENT_TYPES.has(type)) return true
  if (type === 'session.status') {
    const properties = asRecord(asRecord(payload)?.properties)
    const status = asRecord(properties?.status)
    return readString(status ?? {}, 'type') === 'retry'
  }
  if (type !== 'message.part.updated') return false

  const properties = asRecord(asRecord(payload)?.properties)
  const part = asRecord(properties?.part)
  const partType = readString(part ?? {}, 'type')
  return partType === 'tool'
}

const ACTIONABLE_RAW_EVENT_TYPES = new Set([
  'installation.update-available',
  'permission.asked',
  'permission.updated',
  'permission.replied',
  'server.instance.disposed',
  'session.error',
])

function redactRawEvent(type: string, event: OpenCodeEventEnvelope): unknown {
  if (type !== 'message.part.updated') return event
  const payload = asRecord(event.payload)
  const properties = asRecord(payload?.properties)
  const part = asRecord(properties?.part)
  if (!payload || !properties || !part) return event

  const redactedPart = { ...part }
  if (typeof redactedPart.text === 'string') redactedPart.text = `[redacted ${redactedPart.text.length} chars]`
  if (asRecord(redactedPart.state)?.raw) {
    const state = asRecord(redactedPart.state)
    redactedPart.state = { ...state, raw: '[redacted]' }
  }

  return {
    ...event,
    payload: {
      ...payload,
      properties: {
        ...properties,
        part: redactedPart,
      },
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

function readMessageRole(source: Record<string, unknown>): 'user' | 'assistant' | undefined {
  const role = readString(source, 'role')
  return role === 'user' || role === 'assistant' ? role : undefined
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error != null && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: unknown }).data
    if (data != null && typeof data === 'object' && 'message' in data) {
      const message = (data as { message?: unknown }).message
      if (typeof message === 'string') return message
    }
  }
  return String(error)
}

function formatSessionError(error: unknown): string {
  return `opencode session error: ${formatError(error)}`
}

function normalizePath(value: string): string {
  return value.replace(/\\+/g, '/').replace(/\/+$/, '')
}
