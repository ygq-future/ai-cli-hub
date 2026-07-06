/**
 * ClaudeSdkAdapter —— SDK 家族，实现 CLIAdapter（docs/03 §3.1，决策 D11）。
 *
 * 内部持 @anthropic-ai/claude-agent-sdk 的 query() 句柄：
 *  - 流式输入：sendUserInput 推消息进异步队列，query 消费
 *  - 输出：SDK result.result → onOutput(kind=text, final=true)；assistant/user/system 是内部协议消息
 *  - 审批：canUseTool 回调 → 只读工具自动 allow，写操作弹审批
 *  - 无 PtyRuntime、无 ApprovalDetector（审批经 canUseTool 结构化直达）
 */
import {
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
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

/** 只读工具名单：这些自动 allow，不触发审批。 */
const READONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'ListMcpResources',
  'ReadMcpResourceDir',
  'ReadMcpResource',
  'Projects',
])

const READONLY_BASH_COMMANDS = new Set([
  'cat',
  'dir',
  'du',
  'echo',
  'git',
  'grep',
  'head',
  'ls',
  'pwd',
  'tail',
  'tree',
  'type',
  'wc',
  'where',
  'which',
])

const READONLY_GIT_SUBCOMMANDS = new Set(['branch', 'diff', 'log', 'ls-files', 'rev-parse', 'show', 'status'])

const OPERATION_RESULT_GUARDRAIL = [
  'Remote operation guardrail:',
  '- When the user asks you to create, modify, delete, move, or inspect local files or run shell commands, use the available tools to actually do or verify it.',
  '- Never claim a filesystem or shell operation succeeded unless you received a successful tool result in this turn.',
  '- If a required tool was not called, was denied, or failed, say the operation was not completed.',
].join('\n')

/** 异步输入队列。 */
function createInputQueue() {
  const buffer: SDKUserMessage[] = []
  let notify: (() => void) | null = null
  let closed = false

  async function* stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (buffer.length) yield buffer.shift()!
      if (closed) return
      await new Promise<void>(r => (notify = r))
    }
  }

  return {
    stream: stream(),
    push(text: string) {
      buffer.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
      notify?.()
      notify = null
    },
    close() {
      closed = true
      notify?.()
      notify = null
    },
  }
}

/** 从 message.content 数组提取各类型 block。 */
function inputRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function firstShellToken(command: string): string {
  return (
    command
      .trim()
      .split(/\s+/)[0]
      ?.replace(/^.*[\\/]/, '')
      .toLowerCase() ?? ''
  )
}

function isReadOnlyBashCommand(toolInput: unknown): boolean {
  const command = inputRecord(toolInput).command
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed) return false

  // 保守处理：只自动放行单条查询命令；含重定向/管道/串联/替换的一律走审批。
  if (/[;&|<>`$]/.test(trimmed)) return false

  const tool = firstShellToken(trimmed)
  if (!READONLY_BASH_COMMANDS.has(tool)) return false

  if (tool === 'git') {
    const subcommand = trimmed.split(/\s+/)[1]?.toLowerCase() ?? ''
    return READONLY_GIT_SUBCOMMANDS.has(subcommand)
  }

  return true
}

function buildSystemPromptAppend(systemLanguageHint?: string): string {
  return [systemLanguageHint, OPERATION_RESULT_GUARDRAIL].filter(Boolean).join('\n\n')
}

export interface ClaudeSdkAdapterDeps {
  queryFn?: typeof query
  debugRawJson?: boolean
  rawMessageLogger?: (rawJson: string) => void
}

export function createClaudeSdkAdapter(deps?: ClaudeSdkAdapterDeps): CLIAdapter {
  const queryFn = deps?.queryFn ?? query
  const debugRawJson = deps?.debugRawJson ?? false
  const rawMessageLogger = deps?.rawMessageLogger
  const cliType: CliType = 'claude'
  let state: AdapterState = 'stopped'
  let currentQuery: Query | null = null
  let input = createInputQueue()

  const outputHandlers: Array<(d: OutputDelta) => void> = []
  const approvalHandlers: Array<(r: ApprovalRequest) => void> = []
  const exitHandlers: Array<(i: ExitInfo) => void> = []
  const pendingApprovals = new Map<string, (r: PermissionResult) => void>()

  function emit<T>(handlers: Array<(v: T) => void>, value: T) {
    for (const h of handlers) h(value)
  }

  /** 审批策略：只读工具自动 allow，其余弹审批。 */
  const handleCanUseTool: CanUseTool = (toolName, toolInput, { toolUseID }) => {
    if (READONLY_TOOLS.has(toolName) || (toolName === 'Bash' && isReadOnlyBashCommand(toolInput))) {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput, toolUseID })
    }
    return new Promise<PermissionResult>(resolve => {
      pendingApprovals.set(toolUseID, resolve)
      state = 'waitingApproval'
      emit(approvalHandlers, { approvalId: toolUseID, command: toolName, detail: JSON.stringify(toolInput) })
    })
  }

  function stringifyRawMessage(msg: SDKMessage): string {
    try {
      if (msg.type === 'result') return JSON.stringify(redactResultMessage(msg))
      return JSON.stringify(msg)
    } catch {
      return String(msg)
    }
  }

  function redactResultMessage(msg: SDKMessage): SDKMessage {
    const result = msg as unknown as Record<string, unknown>
    if (typeof result.result !== 'string') return msg
    return { ...result, result: '[redacted: result.result omitted from raw debug log]' } as unknown as SDKMessage
  }

  function emitRawMessage(msg: SDKMessage) {
    if (!debugRawJson) return
    if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'thinking_tokens') return
    rawMessageLogger?.(stringifyRawMessage(msg))
  }

  function handleMessage(msg: SDKMessage) {
    emitRawMessage(msg)

    if (msg.type === 'assistant') {
      state = 'busy'
      return
    } else if (msg.type === 'user') {
      return
    } else if (msg.type === 'result') {
      state = 'ready'
      const result = msg as { result?: unknown; errors?: unknown; is_error?: boolean }
      const text =
        typeof result.result === 'string'
          ? result.result
          : Array.isArray(result.errors)
            ? result.errors.filter((x): x is string => typeof x === 'string').join('\n')
            : ''
      emit(outputHandlers, { kind: 'text', text, final: true })
    }
  }

  return {
    cliType,

    async start(opts: SpawnOptions) {
      if (currentQuery) throw new Error('ClaudeSdkAdapter: already started')
      state = 'starting'
      input = createInputQueue()
      const systemPromptAppend = buildSystemPromptAppend(opts.systemLanguageHint)

      const q = queryFn({
        prompt: input.stream,
        options: {
          cwd: opts.cwd,
          canUseTool: handleCanUseTool,
          skills: [],
          plugins: [],
          strictMcpConfig: true,
          settings: {
            disableBundledSkills: true,
            disableAllHooks: true,
          },
          systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: systemPromptAppend,
          },
          ...(opts.env ? { env: opts.env } : {}),
        },
      })
      currentQuery = q
      state = 'ready'

      void (async () => {
        try {
          for await (const msg of q) handleMessage(msg)
          emit(exitHandlers, { code: 0, reason: 'stop' })
        } catch {
          emit(exitHandlers, { code: 1, reason: 'crash' })
        } finally {
          currentQuery = null
          state = 'stopped'
        }
      })()
    },

    async stop() {
      input.close()
      await currentQuery?.interrupt().catch(() => {})
      currentQuery = null
      state = 'stopped'
    },

    interrupt() {
      void currentQuery?.interrupt().catch(() => {})
    },

    sendUserInput(text: string) {
      input.push(text)
      state = 'busy'
    },

    resolveApproval(approvalId: string, decision: ApprovalAction) {
      const resolve = pendingApprovals.get(approvalId)
      if (!resolve) return
      pendingApprovals.delete(approvalId)
      state = 'busy'
      // PermissionResult 要求 allow 时传 updatedInput+toolUseID，deny 时传 message
      if (decision === 'approve') {
        resolve({ behavior: 'allow', updatedInput: {}, toolUseID: approvalId })
      } else {
        resolve({
          behavior: 'deny',
          message: 'User rejected this tool use. Stop the current turn.',
          toolUseID: approvalId,
        })
      }
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

function unsub<T>(list: T[], item: T): Unsubscribe {
  return () => {
    const idx = list.indexOf(item)
    if (idx >= 0) list.splice(idx, 1)
  }
}
