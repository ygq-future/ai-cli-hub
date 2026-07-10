/**
 * OpenCodeSdkAdapter —— SDK 家族，实现 CLIAdapter（D11）。
 *
 * @opencode-ai/sdk 会拉起本机 `opencode serve`，再通过 HTTP/SSE client 操作 session。
 * 输出来自 message.part.updated，审批来自 permission.asked。
 */
import type { Config, OpencodeClient } from '@opencode-ai/sdk'
import type { CliType, Unsubscribe } from '../../shared'
import type {
  AdapterState,
  ApprovalAction,
  ApprovalRequest,
  CLIAdapter,
  ExitInfo,
  OutputDelta,
  SpawnOptions,
} from '../base'
import { sanitizeVisibleText } from '../format-output'

const OPERATION_RESULT_GUARDRAIL = [
  'Remote operation guardrail:',
  '- When the user asks you to create, modify, delete, move, or inspect local files or run shell commands, use the available tools to actually do or verify it.',
  '- Never claim a filesystem or shell operation succeeded unless you received a successful tool result in this turn.',
  '- If a required tool was denied or failed, say the operation was not completed.',
].join('\n')

const EMPTY_VISIBLE_RESULT_MESSAGE = '本轮没有生成可见回复，请重试。'

type CreateOpencodeFn = (options?: { signal?: AbortSignal; config?: Config }) => Promise<{
  client: OpencodeClient
  server: {
    url: string
    close(): void
  }
}>

interface StartedOpenCode {
  client: OpencodeClient
  server: Awaited<ReturnType<CreateOpencodeFn>>['server']
}

interface OpenCodeEventEnvelope {
  directory?: string
  payload: unknown
}

interface PendingOpenCodePermission {
  id: string
  sessionID: string
}

export interface OpenCodeSdkAdapterDeps {
  createOpencodeFn?: CreateOpencodeFn
  debugRawJson?: boolean
  rawMessageLogger?: (rawJson: string) => void
}

export function createOpenCodeSdkAdapter(deps?: OpenCodeSdkAdapterDeps): CLIAdapter {
  const createOpencodeFn = deps?.createOpencodeFn ?? defaultCreateOpencode
  const debugRawJson = deps?.debugRawJson ?? false
  const rawMessageLogger = deps?.rawMessageLogger
  const cliType: CliType = 'opencode'

  let state: AdapterState = 'stopped'
  let started: StartedOpenCode | null = null
  let sessionId: string | null = null
  let cwd = ''
  let systemPrompt = ''
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

  function emit<T>(handlers: Array<(v: T) => void>, value: T) {
    for (const h of handlers) h(value)
  }

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
        state = 'waitingApproval'
        emit(approvalHandlers, permissionToApproval(properties))
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
    emit(outputHandlers, { kind: 'text', text, final: true })
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
    emit(outputHandlers, { kind: 'text', text: visible, final: false })
  }

  function handleToolPart(toolName: string, toolInput: Record<string, unknown>) {
    emit(outputHandlers, { kind: 'tool_use', text: '', final: false, toolName, toolInput })
  }

  function permissionToApproval(permission: Record<string, unknown>): ApprovalRequest {
    const type = readString(permission, 'type') ?? readString(permission, 'permission') ?? 'permission'
    const command = readString(permission, 'title') ?? type
    return {
      approvalId: readString(permission, 'id') ?? '',
      command,
      detail: JSON.stringify({
        type,
        pattern: permission.pattern,
        patterns: permission.patterns,
        metadata: permission.metadata,
        tool: permission.tool,
        always: permission.always,
      }),
    }
  }

  async function listenForEvents(client: OpencodeClient, signal: AbortSignal) {
    try {
      const events = await client.event.subscribe({ query: { directory: cwd }, signal })
      for await (const event of events.stream) {
        if (signal.aborted) return
        handleEvent({ directory: cwd, payload: event })
      }
      emit(exitHandlers, { code: 0, reason: 'stop' })
    } catch {
      if (signal.aborted) return
      emit(exitHandlers, { code: 1, reason: 'crash' })
    } finally {
      if (!signal.aborted) {
        started = null
        sessionId = null
        state = 'stopped'
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

      systemPrompt = buildSystemPrompt(opts.systemLanguageHint)
      const instance = await createOpencodeFn({
        signal: abortController.signal,
        config: buildOpenCodeConfig(systemPrompt),
      })
      started = instance

      const created = await instance.client.session.create({ query: { directory: cwd } })
      if (created.error) throw new Error(`OpenCodeSdkAdapter: failed to create session: ${formatError(created.error)}`)
      sessionId = created.data.id

      eventTask = listenForEvents(instance.client, abortController.signal)
      state = 'ready'
    },

    async stop() {
      const client = started?.client
      const sid = sessionId
      abortController?.abort()
      abortController = null
      if (client && sid) await client.session.abort({ path: { id: sid }, query: { directory: cwd } }).catch(() => {})
      started?.server.close()
      started = null
      sessionId = null
      state = 'stopped'
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
          body: { agent: 'ai_cli_hub', system: systemPrompt, parts: [{ type: 'text', text }] },
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
      void started.client
        .postSessionIdPermissionsPermissionId({
          path: { id: permission.sessionID, permissionID: approvalId },
          query: { directory: cwd },
          body: { response: decision === 'approve' ? 'once' : 'reject' },
        })
        .catch(err => {
          finishTurn(formatError(err))
        })
    },

    onOutput(handler) {
      outputHandlers.push(handler)
      return unsub(outputHandlers, handler)
    },
    onApprovalRequest(handler) {
      approvalHandlers.push(handler)
      return unsub(approvalHandlers, handler)
    },
    onExit(handler) {
      exitHandlers.push(handler)
      return unsub(exitHandlers, handler)
    },

    getState: () => state,
  }
}

function buildOpenCodeConfig(systemPrompt: string): Config {
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
        prompt: systemPrompt,
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

function buildSystemPrompt(systemLanguageHint?: string): string {
  return [systemLanguageHint, OPERATION_RESULT_GUARDRAIL].filter(Boolean).join('\n\n')
}

async function defaultCreateOpencode(options?: Parameters<CreateOpencodeFn>[0]): ReturnType<CreateOpencodeFn> {
  const sdk = await import('@opencode-ai/sdk')
  return sdk.createOpencode(options)
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

function unsub<T>(list: T[], item: T): Unsubscribe {
  return () => {
    const idx = list.indexOf(item)
    if (idx >= 0) list.splice(idx, 1)
  }
}
