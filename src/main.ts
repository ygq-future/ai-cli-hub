/**
 * main.ts —— Composition Root：唯一装配具体实现的地方。
 *
 * 装配顺序（按依赖方向）：
 *  config → logger → bus → db → repositories → aggregator → orchestrator → coreHub → telegramTransport
 *
 * 优雅关闭信号：SIGINT/SIGTERM → transport.stop → orchestrator.destroy → aggregator.destroy → coreHub.destroy
 *
 * 依赖矩阵（CLAUDE.md §3）：只有本文件允许 import 具体实现并装配。
 */
import { createEventBus } from './event'
import { loadConfig } from './config'
import { createLogger, attachEventLogger } from './logger'
import { createDb } from './storage'
import { createRepositories } from './repository'
import { createCoreHub } from './core'
import { createMessageAggregator } from './core'
import { createSessionOrchestrator } from './orchestrator'
import { createTelegramTransport } from './transport'
import type { Transport } from './shared'

async function main() {
  // —— 1. Config ——
  const config = loadConfig()

  // —— 2. Logger + EventBus ——
  const logger = createLogger({ level: config.LOG_LEVEL })
  const bus = createEventBus()
  const detachLogger = attachEventLogger(bus, logger)

  // —— 3. Database ——
  const db = createDb(config.DATABASE_URL)

  // —— 4. Repositories ——
  const repos = createRepositories(db)

  // —— 5. Aggregator ——
  const aggregator = createMessageAggregator(bus, {
    debounceMs: 400,
    minEditIntervalMs: 1000,
    maxChunkChars: 4096,
  })

  // —— 6. Orchestrator（adapter 编排，每会话一个 adapter）——
  const orch = createSessionOrchestrator({ bus, repos, aggregator })

  // —— 7. Core Hub（SessionManager + Auth + MessageRouter）——
  const coreHub = createCoreHub({ bus, repos, config, handler: orch.handler })

  // —— 8. Telegram Transport ——
  const transport: Transport = createTelegramTransport({ bus, config })

  // —— 注册优雅关闭 ——
  function shutdown() {
    logger.info('收到关闭信号，优雅关闭...')
    transport
      .stop()
      .catch(() => {})
      .then(() => orch.destroy())
      .then(() => aggregator.destroy())
      .then(() => coreHub.destroy())
      .then(() => detachLogger())
      .then(() => {
        logger.info('已关闭')
        process.exit(0)
      })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // —— 启动 ——
  logger.info({ cwd: config.DEFAULT_CWD }, 'AI CLI Hub 启动')
  await transport.start()

  // 主进程保持存活（transport.start() 只启 bot，不阻塞；此处挂起防 main 退出）
  await new Promise(() => {})
}

main().catch(err => {
  console.error('启动失败:', err)
  process.exit(1)
})
