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
  type ModelInfo,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
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

function isReadOnlyBashCommand(toolInput: unknown): boolean {
  const command = inputRecord(toolInput).command
  return typeof command === 'string' && isReadOnlyShellCommand(command)
}

export interface ClaudeSdkAdapterDeps {
  queryFn?: typeof query
  claudeCodeExecutablePath?: string
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
  const pendingApprovals = new Map<
    string,
    { resolve: (r: PermissionResult) => void; toolInput: Record<string, unknown> }
  >()

  /** 审批策略：只读工具自动 allow，其余弹审批。 */
  const handleCanUseTool: CanUseTool = (toolName, toolInput, { toolUseID }) => {
    if (isReadOnlyToolName(toolName) || (toolName === 'Bash' && isReadOnlyBashCommand(toolInput))) {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput, toolUseID })
    }
    return new Promise<PermissionResult>(resolve => {
      pendingApprovals.set(toolUseID, { resolve, toolInput: inputRecord(toolInput) })
      state = 'waitingApproval'
      emitHandlers(approvalHandlers, { approvalId: toolUseID, command: toolName, detail: JSON.stringify(toolInput) })
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
    return {
      ...result,
      result: sanitizeVisibleText(result.result),
      result_raw_omitted: true,
      result_raw_chars: result.result.length,
    } as unknown as SDKMessage
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
      const visibleText = sanitizeVisibleText(text)
      emitHandlers(outputHandlers, {
        kind: 'text',
        text: visibleText.trim() ? visibleText : EMPTY_VISIBLE_RESULT_MESSAGE,
        final: true,
      })
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
          model: opts.modelId,
          pathToClaudeCodeExecutable: deps?.claudeCodeExecutablePath,
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
          emitHandlers(exitHandlers, { code: 0, reason: 'stop' })
        } catch {
          emitHandlers(exitHandlers, { code: 1, reason: 'crash' })
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
      const pending = pendingApprovals.get(approvalId)
      if (!pending) return
      pendingApprovals.delete(approvalId)
      state = 'busy'
      // PermissionResult 要求 allow 时传 updatedInput+toolUseID，deny 时传 message
      if (decision === 'approve') {
        pending.resolve({ behavior: 'allow', updatedInput: pending.toolInput, toolUseID: approvalId })
      } else {
        pending.resolve({
          behavior: 'deny',
          message: 'User rejected this tool use. Stop the current turn.',
          toolUseID: approvalId,
        })
      }
    },

    async listModels(): Promise<CliModel[]> {
      if (!currentQuery) throw new Error('ClaudeSdkAdapter: session is not ready')
      return (await currentQuery.supportedModels()).map(toCliModel)
    },

    async setModel(modelId: string): Promise<string> {
      if (!currentQuery) throw new Error('ClaudeSdkAdapter: session is not ready')
      const models = await currentQuery.supportedModels()
      const selected = models.find(model => model.value === modelId || model.resolvedModel === modelId)
      if (!selected) throw new Error(`ClaudeSdkAdapter: model is not available: ${modelId}`)
      await currentQuery.setModel(selected.value)
      return selected.value
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

function toCliModel(model: ModelInfo): CliModel {
  return {
    id: model.value,
    name: model.displayName,
    ...(model.description ? { description: model.description } : {}),
  }
}
