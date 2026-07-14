// cli —— CLI 适配器语义接缝（base）+ 各家族实现。
// 契约见 docs/03-Interface-Contracts.md §3.1，家族划分见决策 D11。
export type {
  CLIAdapter,
  CliModel,
  OutputDelta,
  ApprovalRequest,
  ApprovalAction,
  ExitInfo,
  SpawnOptions,
  AdapterState,
} from './base'
export { createClaudeSdkAdapter } from './claude/claude-sdk-adapter'
export { resolveSystemClaudeExecutable } from './claude/system-claude'
export { createOpenCodeSdkAdapter } from './opencode/opencode-sdk-adapter'
export { createOpenCodeServerPool } from './opencode/opencode-server-pool'
export type { OpenCodeServerPool } from './opencode/opencode-server-pool'
export { formatOutputDelta } from './format-output'
export { EMPTY_VISIBLE_RESULT_MESSAGE, OPERATION_RESULT_GUARDRAIL } from './constants'
export { buildSystemPromptAppend, emitHandlers, unsubscribeHandler } from './utils'
