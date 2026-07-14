/**
 * CLIAdapter —— Core / Transport 唯一依赖的语义接缝。
 *
 * Adapter 分两家族，同实现此接口、对外完全同形：
 * - SDK 家族（Claude 等有 Agent SDK 的 CLI）：内部持 SDK query() 句柄，审批经 canUseTool 回调
 * - PTY 家族（无 SDK 的 CLI）：内部持 PtyRuntime + ApprovalDetector，字节级 scraping
 *
 * 依赖矩阵：cli/ 允许依赖 event/ config/ shared/ + 对应 SDK，禁止依赖 transport/ storage/。
 * docs/03-Interface-Contracts.md §3.1
 */
import type { CliModel, CliType, ConversationId, Unsubscribe } from '../shared'

export type { CliModel } from '../shared'

export interface CLIAdapter {
  readonly cliType: CliType

  start(opts: SpawnOptions): Promise<void>
  stop(): Promise<void>
  interrupt(): void // Ctrl+C / query.interrupt()

  /** 一轮用户输入（字符串在两家族天然成立，非 PTY 泄漏） */
  sendUserInput(text: string): void

  /** 可选：SDK 家族用于注入隐藏上下文，不应触发模型回复或进入用户可见消息。 */
  sendContext?(text: string): Promise<void> | void

  /** 用户可见输出（语义，非裸字节；Claude SDK 家族只发 result.result） */
  onOutput(handler: (delta: OutputDelta) => void): Unsubscribe
  onApprovalRequest(handler: (req: ApprovalRequest) => void): Unsubscribe
  resolveApproval(approvalId: string, decision: ApprovalAction): void
  onExit(handler: (info: ExitInfo) => void): Unsubscribe

  /** 当前 CLI/账号实际可用的模型目录。 */
  listModels(): Promise<CliModel[]>
  /** 切换后续轮次使用的模型，返回规范化后的持久化 model ID。 */
  setModel(modelId: string): Promise<string>

  getState(): AdapterState
}

export interface OutputDelta {
  /** 输出类型：text=用户可见文本；其它类型保留给 PTY/未来 adapter 内部转换 */
  kind: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  /** kind=text/tool_result/thinking 时填充；tool_use 时为空 */
  text: string
  /** false=增量，true=本轮结束 */
  final: boolean
  /** kind=tool_use 时填充（如 "Bash" "Write"） */
  toolName?: string
  /** kind=tool_use 时填充 */
  toolInput?: Record<string, unknown>
}

export interface ApprovalRequest {
  approvalId: string
  command: string // SDK=工具名（如 "Bash"）；PTY=scraping 提取的命令
  detail: string // SDK=JSON.stringify(input)；PTY=上下文
}

export type ApprovalAction = 'approve' | 'reject'

export interface ExitInfo {
  code: number | null
  reason: 'idleTimeout' | 'crash' | 'stop'
}

export interface SpawnOptions {
  conversationId: ConversationId
  cwd: string
  cols?: number // 仅 PTY 家族用
  rows?: number // 仅 PTY 家族用
  env?: Record<string, string>
  systemLanguageHint?: string
  modelId?: string
}

export type AdapterState = 'stopped' | 'starting' | 'ready' | 'busy' | 'waitingApproval'
