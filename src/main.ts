/**
 * Composition Root —— 唯一装配具体实现的地方（见 CLAUDE.md §3 / docs/03 §7）。
 * M1：loadConfig → createLogger(config) → createEventBus → 挂 logger 订阅全部事件。
 * 后续里程碑在此继续装配 repositories → core → adapters → transports。
 */
import { loadConfig } from './config'
import { createEventBus } from './event'
import { attachEventLogger, createLogger } from './logger'

const config = loadConfig()
const logger = createLogger({ level: config.LOG_LEVEL })
const bus = createEventBus()
attachEventLogger(bus, logger)

logger.info(
  { phase: 'M1', whitelist: config.WHITELIST_USER_IDS.length, logLevel: config.LOG_LEVEL },
  'AI CLI Hub — 配置就绪，事件总线已挂载',
)

// TODO(M2): const db = createDb(config.DATABASE_URL); const repos = createRepositories(db)
// TODO(M3): const core = createCoreHub({ bus, repos, config })
// TODO(M4): core.registerAdapter(new ClaudeCLIAdapter(...))
// TODO(M6): await new TelegramTransport({ bus, config }).start()
// 详见 docs/05-Implementation-Plan.md
