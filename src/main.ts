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
import { access } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createEventBus } from './event'
import { loadConfig, normalizeProxyEnvironment } from './config'
import { createLogger, attachEventLogger } from './logger'
import { closeDb, createDb } from './storage'
import { createRepositories } from './repository'
import { createCoreHub } from './core'
import { createMessageAggregator } from './core'
import { createClaudeSdkAdapter, createOpenCodeSdkAdapter } from './cli'
import { createApprovalAudit } from './audit'
import { createMemoryModule } from './memory'
import { createLightOcrProvider, createMediaPreprocessor } from './media'
import {
  createHealthReporter,
  createRestartNoticeStore,
  createRestartRunner,
  createUpdateRunner,
  type CommandResult,
  type HealthCheckResult,
} from './ops'
import { createSessionOrchestrator } from './orchestrator'
import { createTelegramTransport } from './transport'
import type { Transport } from './shared'

async function main() {
  // —— 1. Config ——
  normalizeProxyEnvironment()
  const config = loadConfig()

  // —— 2. Logger + EventBus ——
  const logger = createLogger({ level: config.LOG_LEVEL })
  const bus = createEventBus()
  const detachLogger = attachEventLogger(bus, logger)
  const messageFlowLogger = (event: string, data: Record<string, unknown>) =>
    logger.info({ event, ...data }, 'Message flow debug')

  // —— 3. Database ——
  const db = createDb(config.DATABASE_URL)

  // —— 4. Repositories ——
  const repos = createRepositories(db)
  await repos.conversations.reconcileRuntimeStatuses(Date.now())

  // —— 4b. Operations health reporter ——
  const health = createHealthReporter({
    config,
    startedAt: Date.now(),
    checkDatabase: () =>
      withHealthTimeout(
        async () => {
          await db.execute(sql`select 1`)
          return { name: 'database', status: 'ok', detail: 'Postgres ping ok', critical: true }
        },
        config.ENV_PROBE_TIMEOUT_MS,
        'database',
      ),
    checkDirectory: dir => checkDirectory(dir),
    checkCommand: command => checkCommand(command, config.ENV_PROBE_TIMEOUT_MS),
  })
  const restartNotices = createRestartNoticeStore(config.UPDATE_RESTART_NOTICE_FILE)
  const scheduleRestart = (command: string, args: string[], cwd: string, delayMs: number) => {
    setTimeout(() => {
      void runCommand(command, args, cwd, config.UPDATE_COMMAND_TIMEOUT_MS).catch(err => {
        logger.error({ err, command, args }, 'Scheduled restart command failed')
      })
    }, delayMs)
  }
  const updater = createUpdateRunner({
    config,
    runCommand,
    writeRestartNotice: ref => restartNotices.write({ ref, requestedAt: Date.now() }),
    scheduleRestart,
  })
  const restarter = createRestartRunner({
    config,
    writeRestartNotice: ref => restartNotices.write({ ref, requestedAt: Date.now() }),
    scheduleRestart,
  })

  // —— 5. Audit（审批事件旁路落库）——
  const approvalAudit = createApprovalAudit({ bus, audit: repos.audit })

  // —— 6. Memory（环境快照 + 全局记忆召回）——
  const memory = await createMemoryModule({
    bus,
    repos,
    config,
    debugMessageFlow: config.DEBUG_MESSAGE_FLOW,
    messageFlowLogger,
  })

  // —— 7. Aggregator ——
  const aggregator = createMessageAggregator(bus, {
    debounceMs: config.AGGREGATOR_DEBOUNCE_MS,
    minEditIntervalMs: config.AGGREGATOR_MIN_EDIT_INTERVAL_MS,
    maxChunkChars: config.AGGREGATOR_MAX_CHUNK_CHARS,
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
    adapterFactory: cli => {
      if (cli === 'opencode') {
        return createOpenCodeSdkAdapter({
          debugRawJson: config.DEBUG_AGENT_SDK_JSON,
          rawMessageLogger: rawJson => logger.info({ cli: 'opencode', rawJson }, 'Agent SDK raw message'),
        })
      }
      return createClaudeSdkAdapter({
        debugRawJson: config.DEBUG_AGENT_SDK_JSON,
        rawMessageLogger: rawJson => logger.info({ cli: 'claude', rawJson }, 'Agent SDK raw message'),
      })
    },
    getUserLanguage: telegram.getUserLanguage,
    getSystemMemoryHint: memory.recallGlobalContext,
    getRelevantMemoryHint: memory.recallRelevantContext,
    agentDescription: config.AGENT_DESCRIPTION,
    debugMessageFlow: config.DEBUG_MESSAGE_FLOW,
    messageFlowLogger,
    idleTimeoutMs: config.AGENT_IDLE_TIMEOUT_MS,
    turnTimeoutMs: config.AGENT_TURN_TIMEOUT_MS,
    recentContextLimit: config.RECENT_CONTEXT_LIMIT,
    recentContextMessageMaxChars: config.RECENT_CONTEXT_MESSAGE_MAX_CHARS,
  })

  // —— 10. Core Hub（SessionManager + Auth + MessageRouter）——
  const coreHub = createCoreHub({
    bus,
    repos,
    config,
    handler: orch.handler,
    getUserLanguage: telegram.getUserLanguage,
    resolveCwd,
    refreshEnvironmentSnapshot: memory.refreshEnvironmentSnapshot,
    getHealthReport: health.getReport,
    getUpdatePreview: updater.preview,
    performUpdate: updater.run,
    getRestartPreview: restarter.preview,
    performRestart: restarter.run,
  })

  // —— 注册优雅关闭 ——
  let shuttingDown = false
  async function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('收到关闭信号，优雅关闭...')
    try {
      await withTimeout(
        (async () => {
          await transport.stop()
          aggregator.flushAll()
          await orch.destroy()
          memory.destroy()
          approvalAudit.destroy()
          aggregator.destroy()
          coreHub.destroy()
          await closeDb(db)
          detachLogger()
        })(),
        config.SERVICE_SHUTDOWN_TIMEOUT_MS,
        'shutdown',
      )
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
  await notifyRestartComplete(restartNotices, transport, logger)

  // 主进程保持存活（transport.start() 只启 bot，不阻塞；此处挂起防 main 退出）
  await new Promise(() => {})
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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

async function withHealthTimeout(
  check: () => Promise<HealthCheckResult>,
  ms: number,
  name: string,
): Promise<HealthCheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      check(),
      new Promise<HealthCheckResult>(resolve => {
        timer = setTimeout(() => resolve({ name, status: 'down', detail: `timed out after ${ms}ms` }), ms)
      }),
    ])
  } catch (err) {
    return { name, status: 'down', detail: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function checkDirectory(dir: string): Promise<HealthCheckResult> {
  const resolved = path.resolve(dir)
  try {
    const stat = statSync(resolved)
    if (!stat.isDirectory()) return { name: 'directory', status: 'down', detail: `${resolved} is not a directory` }
    await access(resolved, 0o6)
    return { name: 'directory', status: 'ok', detail: `${resolved} readable/writable` }
  } catch (err) {
    return {
      name: 'directory',
      status: 'down',
      detail: err instanceof Error ? `${resolved}: ${err.message}` : `${resolved}: ${String(err)}`,
    }
  }
}

async function checkCommand(command: string, timeoutMs: number): Promise<HealthCheckResult> {
  const resolver = process.platform === 'win32' ? 'where.exe' : 'which'
  return withHealthTimeout(
    async () => {
      const proc = Bun.spawn([resolver, command], { stdout: 'pipe', stderr: 'pipe' })
      const code = await proc.exited
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text()
        return { name: command, status: 'down', detail: stderr.trim() || `${command} not found` }
      }
      const stdout = await new Response(proc.stdout).text()
      return { name: command, status: 'ok', detail: firstLine(stdout) || `${command} found` }
    },
    timeoutMs,
    command,
  )
}

async function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const proc = Bun.spawn([command, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  try {
    const timedExit = Promise.race([
      proc.exited,
      new Promise<number>(resolve => {
        timer = setTimeout(() => {
          proc.kill()
          resolve(124)
        }, timeoutMs)
      }),
    ])
    const [code, stdout, stderr] = await Promise.all([
      timedExit,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, stdout, stderr: code === 124 ? appendLine(stderr, `timed out after ${timeoutMs}ms`) : stderr }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function appendLine(text: string, line: string): string {
  return text.trim() ? `${text.trimEnd()}\n${line}` : line
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean)
      ?.replace(/\\+/g, '/') ?? ''
  )
}

async function notifyRestartComplete(
  store: ReturnType<typeof createRestartNoticeStore>,
  transport: Transport,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    const notice = await store.consume()
    if (!notice) return
    await transport.sendMessage(notice.ref.chatId, '✅ 服务已重启完成，可以继续发送消息。')
  } catch (err) {
    logger.error({ err }, 'Failed to send restart completion notification')
  }
}

main().catch(err => {
  process.stderr.write(`启动失败: ${err instanceof Error ? err.stack || err.message : String(err)}\n`)
  process.exit(1)
})
