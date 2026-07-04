/**
 * ClaudeSdkAdapter —— SDK 家族，实现 CLIAdapter（docs/03 §3.1，决策 D11）。
 *
 * 内部持 @anthropic-ai/claude-agent-sdk 的 query() 句柄：
 *  - 流式输入：sendUserInput 推消息进异步队列，query 消费
 *  - 输出：assistant text/tool_use/tool_result/thinking → onOutput(kind,text,final)
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
function extractBlocks(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? content.filter(Boolean) : []
}

export function createClaudeSdkAdapter(deps?: { queryFn?: typeof query }): CLIAdapter {
  const queryFn = deps?.queryFn ?? query
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
    if (READONLY_TOOLS.has(toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput, toolUseID })
    }
    return new Promise<PermissionResult>(resolve => {
      pendingApprovals.set(toolUseID, resolve)
      state = 'waitingApproval'
      emit(approvalHandlers, { approvalId: toolUseID, command: toolName, detail: JSON.stringify(toolInput) })
    })
  }

  function handleMessage(msg: SDKMessage) {
    if (msg.type === 'assistant') {
      state = 'busy'
      const blocks = extractBlocks((msg as { message: { content: unknown } }).message?.content)
      for (const b of blocks) {
        const t = b.type as string
        if (t === 'text') {
          emit(outputHandlers, { kind: 'text', text: b.text as string, final: false })
        } else if (t === 'tool_use') {
          emit(outputHandlers, {
            kind: 'tool_use',
            text: '',
            final: false,
            toolName: b.name as string,
            toolInput: b.input as Record<string, unknown> | undefined,
          })
        } else if (t === 'thinking') {
          const text = (b.thinking as string) || ''
          if (text) emit(outputHandlers, { kind: 'thinking', text, final: false })
        }
      }
    } else if (msg.type === 'user') {
      // tool_result 以 user 消息返回
      const blocks = extractBlocks((msg as { message: { content: unknown } }).message?.content)
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const c = b.content
          const text =
            typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? c.map((x: Record<string, unknown>) => x.text ?? '').join('')
                : ''
          if (text) emit(outputHandlers, { kind: 'tool_result', text, final: false })
        }
      }
    } else if (msg.type === 'result') {
      state = 'ready'
      emit(outputHandlers, { kind: 'text', text: '', final: true })
    }
  }

  return {
    cliType,

    async start(opts: SpawnOptions) {
      if (currentQuery) throw new Error('ClaudeSdkAdapter: already started')
      state = 'starting'
      input = createInputQueue()

      const q = queryFn({
        prompt: input.stream,
        options: {
          cwd: opts.cwd,
          canUseTool: handleCanUseTool,
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
        resolve({ behavior: 'deny', message: 'User rejected', toolUseID: approvalId })
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
