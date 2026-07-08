/**
 * main.ts —— Composition Root：唯一装配具体实现的地方。
 *
 * 装配顺序（按依赖方向）：
 *  config → logger → bus → db → repositories → audit → memory → aggregator → telegramTransport → orchestrator → coreHub
 *
 * 优雅关闭信号：SIGINT/SIGTERM → transport.stop → orchestrator.destroy → memory.destroy → audit.destroy → aggregator.destroy → coreHub.destroy
 *
 * 依赖矩阵（CLAUDE.md §3）：只有本文件允许 import 具体实现并装配。
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { createEventBus } from './event'
import { loadConfig } from './config'
import { createLogger, attachEventLogger } from './logger'
import { createDb } from './storage'
import { createRepositories } from './repository'
import { createCoreHub } from './core'
import { createMessageAggregator } from './core'
import { createClaudeSdkAdapter } from './cli'
import { createApprovalAudit } from './audit'
import { createMemoryModule } from './memory'
import { createLightOcrProvider, createMediaPreprocessor } from './media'
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

  // —— 5. Audit（审批事件旁路落库）——
  const approvalAudit = createApprovalAudit({ bus, audit: repos.audit })

  // —— 6. Memory（环境快照 + 全局记忆召回）——
  const memory = await createMemoryModule({ bus, repos, config })

  // —— 7. Aggregator ——
  const aggregator = createMessageAggregator(bus, {
    debounceMs: 400,
    minEditIntervalMs: 1000,
    maxChunkChars: 4096,
  })

  // —— 8. Media + Telegram Transport ——
  const ocrProvider = createLightOcrProvider({
    baseUrl: config.OCR_API_BASE_URL,
    timeoutMs: config.OCR_API_TIMEOUT_MS,
  })
  const mediaPreprocessor = createMediaPreprocessor({
    maxTextChars: config.MEDIA_MAX_TEXT_CHARS,
    ocrProvider,
  })
  const telegram = createTelegramTransport({ bus, config, mediaPreprocessor })
  const transport: Transport = telegram

  // —— 9. Orchestrator（adapter 编排，每会话一个 adapter）——
  const orch = createSessionOrchestrator({
    bus,
    repos,
    aggregator,
    adapterFactory: () =>
      createClaudeSdkAdapter({
        debugRawJson: config.DEBUG_AGENT_SDK_JSON,
        rawMessageLogger: rawJson => logger.info({ cli: 'claude', rawJson }, 'Agent SDK raw message'),
      }),
    getUserLanguage: telegram.getUserLanguage,
    getSystemMemoryHint: memory.recallGlobalContext,
    agentDescription: config.AGENT_DESCRIPTION,
    debugDiagnostics: config.DEBUG_AGENT_SDK_JSON,
    diagnosticLogger: (event, data) => logger.info({ event, ...data }, 'Orchestrator diagnostic'),
    idleTimeoutMs: config.AGENT_IDLE_TIMEOUT_MS,
  })

  // —— 10. Core Hub（SessionManager + Auth + MessageRouter）——
  const coreHub = createCoreHub({
    bus,
    repos,
    config,
    handler: orch.handler,
    getUserLanguage: telegram.getUserLanguage,
    resolveCwd,
  })

  // —— 注册优雅关闭 ——
  let shuttingDown = false
  async function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('收到关闭信号，优雅关闭...')
    try {
      await transport.stop()
      await orch.destroy()
      memory.destroy()
      approvalAudit.destroy()
      await aggregator.destroy()
      await coreHub.destroy()
      detachLogger()
      logger.info('已关闭')
      process.exit(0)
    } catch (err) {
      logger.error({ err }, '关闭失败')
      process.exit(1)
    }
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  // —— 启动 ——
  logger.info({ cwd: config.DEFAULT_CWD }, 'AI CLI Hub 启动')
  await transport.start()

  // 主进程保持存活（transport.start() 只启 bot，不阻塞；此处挂起防 main 退出）
  await new Promise(() => {})
}

function resolveCwd(raw: string): { ok: true; cwd: string } | { ok: false; message: string } {
  const cwd = raw.trim().replace(/\\+/g, '/')
  if (!cwd) return { ok: false, message: '工作目录不能为空。' }
  if (!path.isAbsolute(cwd) && !path.win32.isAbsolute(cwd) && !path.posix.isAbsolute(cwd)) {
    return { ok: false, message: `工作目录必须是绝对路径：${cwd}` }
  }
  if (!existsSync(cwd)) return { ok: false, message: `目录不存在：${cwd}` }
  if (!statSync(cwd).isDirectory()) return { ok: false, message: `路径不是目录：${cwd}` }
  return { ok: true, cwd }
}

main().catch(err => {
  console.error('启动失败:', err)
  process.exit(1)
})
