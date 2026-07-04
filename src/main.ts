/**
 * Composition Root —— 唯一装配具体实现的地方（见 CLAUDE.md §3 / docs/03 §7）。
 * M1：loadConfig → createLogger(config) → createEventBus → 挂 logger 订阅全部事件。
 * 后续里程碑在此继续装配 repositories → core → adapters → transports。
 */
import { loadConfig } from './config'
import { createEventBus } from './event'
import { attachEventLogger, createLogger } from './logger'
import { formatOutputDelta } from './cli'
import type { CLIAdapter } from './cli'
import type { MessageAggregator } from './core'
import type { ConversationId, Unsubscribe } from './shared'

const config = loadConfig()
const logger = createLogger({ level: config.LOG_LEVEL })
const bus = createEventBus()
attachEventLogger(bus, logger)

logger.info(
  { phase: 'M1', whitelist: config.WHITELIST_USER_IDS.length, logLevel: config.LOG_LEVEL },
  'AI CLI Hub — 配置就绪，事件总线已挂载',
)

/**
 * M5 接线：Adapter 语义输出流 → 聚合器 → MessageGenerated。
 * Composition Root 是唯一可同时 import cli（CLIAdapter/OutputDelta）与 core（聚合器）的层
 * （依赖矩阵禁止 core → cli）。M6 每会话 start 后调用本函数，退订随会话生命周期收回。
 */
export function bindAdapterOutput(
  adapter: CLIAdapter,
  conversationId: ConversationId,
  aggregator: MessageAggregator,
): Unsubscribe {
  return adapter.onOutput(delta => {
    const text = formatOutputDelta(delta)
    if (text) aggregator.push(conversationId, text)
    if (delta.final) aggregator.flush(conversationId)
  })
}

// TODO(M2): const db = createDb(config.DATABASE_URL); const repos = createRepositories(db)
// M3: const coreHub = createCoreHub({ bus, repos: repos!, config, mockHandler })
// M4 就绪: import { createClaudeSdkAdapter } from './cli'  // SDK 家族，审批经 canUseTool
//          import { createPtyRuntime } from './runtime'    // PTY 家族备用
// M5 就绪: const aggregator = createMessageAggregator(bus)  // 聚合器
//          bindAdapterOutput(adapter, conversationId, aggregator)  // 每会话接线（M6 调用）
// TODO(M6): await new TelegramTransport({ bus, config }).start()
// 详见 docs/05-Implementation-Plan.md
