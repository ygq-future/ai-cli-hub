/**
 * core —— 核心调度：SessionManager 状态机、Auth、MessageRouter、CoreHub。
 *
 * 禁止依赖任何具体实现（见 CLAUDE.md 依赖矩阵）。
 * 依赖注入由 Composition Root (src/main.ts) 完成。
 */
export { transition, getValidTransitions, getValidTransitionKeys } from './session-machine'
export type { SessionEvent } from './session-machine'
export { createAuth } from './auth'
export type { Auth, AuthResult } from './auth'
export { createSessionManager } from './session-manager'
export type { SessionManager } from './session-manager'
export { createMessageRouter } from './message-router'
export type { MessageRouter, MessageHandler } from './message-router'
export { createMessageAggregator, DEFAULT_AGGREGATOR_CONFIG } from './aggregator'
export type { MessageAggregator, AggregatorConfig } from './aggregator'
export { createCoreHub } from './core-hub'
export type { CoreHub, CoreHubOptions } from './core-hub'
