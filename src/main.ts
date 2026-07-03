/**
 * Composition Root —— 唯一装配具体实现的地方（见 CLAUDE.md §3 / docs/03 §7）。
 * M0：仅初始化 logger 并打印一行启动日志。
 * 后续里程碑在此逐步装配 config → event bus → repositories → core → adapters → transports。
 */
import { createLogger } from './logger'

const logger = createLogger()

logger.info({ phase: 'M0', milestone: 'skeleton' }, 'AI CLI Hub — 工程骨架就绪')

// TODO(M1): const config = loadConfig(); const bus = createEventBus(); logger 订阅全部事件
// TODO(M2): const db = createDb(config.DATABASE_URL); const repos = createRepositories(db)
// TODO(M3): const core = createCoreHub({ bus, repos, config })
// TODO(M4): core.registerAdapter(new ClaudeCLIAdapter(...))
// TODO(M6): await new TelegramTransport({ bus, config }).start()
// 详见 docs/05-Implementation-Plan.md
