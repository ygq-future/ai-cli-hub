/**
 * config —— 唯一读取配置的地方（Zod 强类型 + fail-fast）。
 * 配置源为 settings.json；不再从 process.env 读取业务配置。
 * 契约见 docs/03-Interface-Contracts.md §6。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

// —— JSON 配置的 Zod schema（嵌套，对应 settings.json 13 分类）——

const proxyField = () => z.string().default('')

const TransportJsonSchema = z.object({
  httpProxy: proxyField(),
  httpsProxy: proxyField(),
  noProxy: z.string().default('localhost,127.0.0.1'),
  telegramBotToken: z.string().default(''),
  qqBotAppId: z.string().default(''),
  qqBotAppSecret: z.string().default(''),
  qqBotWsProxy: z.string().default(''),
  qqBotOpenIdDiscovery: z.boolean().default(false),
  whitelistUserIds: z.array(z.string()).default([]),
})

const DatabaseJsonSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(5432),
  db: z.string().default('ai_cli_hub'),
  username: z.string().default(''),
  password: z.string().default(''),
})

const EmbeddingJsonSchema = z.object({
  apiBaseUrl: z.string().default('https://api.openai.com/v1'),
  apiKey: z.string().default(''),
  model: z.string().default('BAAI/bge-m3'),
  dimensions: z.number().int().positive().default(1024),
})

const SummaryJsonSchema = z.object({
  apiBaseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  requestedSummaryMessageLimit: z.number().int().positive().default(10),
  maxChars: z.number().int().positive().default(600),
})

const MemoryJsonSchema = z.object({
  embedding: EmbeddingJsonSchema,
  recallTopK: z.number().int().positive().default(10),
  summary: SummaryJsonSchema,
})

const LifecycleJsonSchema = z.object({
  agentIdleTimeoutMs: z.number().int().positive().default(300_000),
  agentTurnTimeoutMs: z.number().int().positive().default(60_000),
  serviceShutdownTimeoutMs: z.number().int().positive().default(15_000),
  sessionArchiveDays: z.number().int().positive().default(7),
})

const SessionJsonSchema = z.object({
  defaultCwd: z.string().nullable().default(null),
  agentDescription: z.string().default(''),
  recentContextLimit: z.number().int().positive().default(10),
  recentContextMessageMaxChars: z.number().int().positive().default(1200),
})

const AggregatorJsonSchema = z.object({
  debounceMs: z.number().int().nonnegative().default(400),
  minEditIntervalMs: z.number().int().nonnegative().default(1000),
  maxChunkChars: z.number().int().positive().default(4096),
})

const MediaJsonSchema = z.object({
  downloadDir: z.string().default('.data/media'),
  maxFileBytes: z
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  maxTextChars: z.number().int().positive().default(20_000),
  parseTimeoutMs: z.number().int().positive().default(30_000),
})

const OcrJsonSchema = z.object({
  apiBaseUrl: z.string().default(''),
  apiTimeoutMs: z.number().int().positive().default(30_000),
})

const EnvProbeJsonSchema = z.object({
  timeoutMs: z.number().int().positive().default(1500),
})

const OpsJsonSchema = z.object({
  workdir: z.string().nullable().default(null),
  commandTimeoutMs: z.number().int().positive().default(120_000),
  requireCleanWorktree: z.boolean().default(true),
  restartCommand: z.string().default('pm2'),
  restartArgs: z.array(z.string()).default(['restart', 'ai-cli-hub']),
  restartDelayMs: z.number().int().positive().default(1500),
  restartNoticeFile: z.string().default('.data/update-restart-notice.json'),
})

const LoggingJsonSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

const DebugJsonSchema = z.object({
  agentSdkJson: z.boolean().default(false),
  messageFlow: z.boolean().default(false),
})

/** settings.json 顶层结构（用户可读的嵌套 JSON）。 */
export const SettingsJsonSchema = z.object({
  transport: TransportJsonSchema,
  database: DatabaseJsonSchema,
  memory: MemoryJsonSchema,
  lifecycle: LifecycleJsonSchema,
  session: SessionJsonSchema,
  aggregator: AggregatorJsonSchema,
  media: MediaJsonSchema,
  ocr: OcrJsonSchema,
  envProbe: EnvProbeJsonSchema,
  ops: OpsJsonSchema,
  logging: LoggingJsonSchema,
  debug: DebugJsonSchema,
})

export type SettingsJson = z.infer<typeof SettingsJsonSchema>

// —— 内部扁平 AppConfig（保持向消费者兼容）——

export type AppConfig = {
  // transport
  TELEGRAM_BOT_TOKEN: string
  QQBOT_APP_ID: string
  QQBOT_APP_SECRET: string
  QQBOT_OPENID_DISCOVERY: boolean
  QQBOT_WS_PROXY: string
  WHITELIST_USER_IDS: string[]
  // database
  DATABASE_URL: string
  // memory / embedding
  EMBEDDING_API_BASE_URL: string
  EMBEDDING_API_KEY: string
  EMBEDDING_MODEL: string
  EMBEDDING_DIMENSIONS: number
  MEMORY_RECALL_TOP_K: number
  MEMORY_SUMMARY_API_BASE_URL: string
  MEMORY_SUMMARY_API_KEY: string
  MEMORY_SUMMARY_MODEL: string
  MEMORY_REQUESTED_SUMMARY_MESSAGE_LIMIT: number
  MEMORY_SUMMARY_MAX_CHARS: number
  // lifecycle
  AGENT_IDLE_TIMEOUT_MS: number
  AGENT_TURN_TIMEOUT_MS: number
  SERVICE_SHUTDOWN_TIMEOUT_MS: number
  SESSION_ARCHIVE_DAYS: number
  // session
  DEFAULT_CWD: string
  AGENT_DESCRIPTION: string
  RECENT_CONTEXT_LIMIT: number
  RECENT_CONTEXT_MESSAGE_MAX_CHARS: number
  // aggregator
  AGGREGATOR_DEBOUNCE_MS: number
  AGGREGATOR_MIN_EDIT_INTERVAL_MS: number
  AGGREGATOR_MAX_CHUNK_CHARS: number
  // media
  MEDIA_DOWNLOAD_DIR: string
  MEDIA_MAX_FILE_BYTES: number
  MEDIA_MAX_TEXT_CHARS: number
  MEDIA_PARSE_TIMEOUT_MS: number
  // ocr
  OCR_API_BASE_URL: string
  OCR_API_TIMEOUT_MS: number
  // env probe
  ENV_PROBE_TIMEOUT_MS: number
  // ops
  UPDATE_WORKDIR: string
  UPDATE_COMMAND_TIMEOUT_MS: number
  UPDATE_REQUIRE_CLEAN_WORKTREE: boolean
  UPDATE_RESTART_COMMAND: string
  UPDATE_RESTART_ARGS: string[]
  UPDATE_RESTART_DELAY_MS: number
  UPDATE_RESTART_NOTICE_FILE: string
  // logging
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error'
  // debug
  DEBUG_AGENT_SDK_JSON: boolean
  DEBUG_MESSAGE_FLOW: boolean
}

const SETTINGS_PATH = 'settings.json'

function buildDatabaseUrl(db: z.infer<typeof DatabaseJsonSchema>): string {
  const u = db.username ? encodeURIComponent(db.username) : ''
  const p = db.password ? encodeURIComponent(db.password) : ''
  const auth = u ? `${u}:${p}@` : ''
  return `postgres://${auth}${db.host}:${db.port}/${db.db}`
}

/** 把嵌套 JSON 展平为向下兼容的 AppConfig。 */
function flattenSettings(json: SettingsJson): AppConfig {
  const { transport, database, memory, lifecycle, session, aggregator, media, ocr, envProbe, ops, logging, debug } =
    json

  return {
    TELEGRAM_BOT_TOKEN: transport.telegramBotToken,
    QQBOT_APP_ID: transport.qqBotAppId,
    QQBOT_APP_SECRET: transport.qqBotAppSecret,
    QQBOT_OPENID_DISCOVERY: transport.qqBotOpenIdDiscovery,
    QQBOT_WS_PROXY: transport.qqBotWsProxy,
    WHITELIST_USER_IDS: transport.whitelistUserIds,

    DATABASE_URL: buildDatabaseUrl(database),

    EMBEDDING_API_BASE_URL: memory.embedding.apiBaseUrl,
    EMBEDDING_API_KEY: memory.embedding.apiKey,
    EMBEDDING_MODEL: memory.embedding.model,
    EMBEDDING_DIMENSIONS: memory.embedding.dimensions,
    MEMORY_RECALL_TOP_K: memory.recallTopK,
    MEMORY_SUMMARY_API_BASE_URL: memory.summary.apiBaseUrl,
    MEMORY_SUMMARY_API_KEY: memory.summary.apiKey,
    MEMORY_SUMMARY_MODEL: memory.summary.model,
    MEMORY_REQUESTED_SUMMARY_MESSAGE_LIMIT: memory.summary.requestedSummaryMessageLimit,
    MEMORY_SUMMARY_MAX_CHARS: memory.summary.maxChars,

    AGENT_IDLE_TIMEOUT_MS: lifecycle.agentIdleTimeoutMs,
    AGENT_TURN_TIMEOUT_MS: lifecycle.agentTurnTimeoutMs,
    SERVICE_SHUTDOWN_TIMEOUT_MS: lifecycle.serviceShutdownTimeoutMs,
    SESSION_ARCHIVE_DAYS: lifecycle.sessionArchiveDays,

    DEFAULT_CWD: session.defaultCwd ?? process.cwd(),
    AGENT_DESCRIPTION: session.agentDescription,
    RECENT_CONTEXT_LIMIT: session.recentContextLimit,
    RECENT_CONTEXT_MESSAGE_MAX_CHARS: session.recentContextMessageMaxChars,

    AGGREGATOR_DEBOUNCE_MS: aggregator.debounceMs,
    AGGREGATOR_MIN_EDIT_INTERVAL_MS: aggregator.minEditIntervalMs,
    AGGREGATOR_MAX_CHUNK_CHARS: aggregator.maxChunkChars,

    MEDIA_DOWNLOAD_DIR: media.downloadDir,
    MEDIA_MAX_FILE_BYTES: media.maxFileBytes,
    MEDIA_MAX_TEXT_CHARS: media.maxTextChars,
    MEDIA_PARSE_TIMEOUT_MS: media.parseTimeoutMs,

    OCR_API_BASE_URL: ocr.apiBaseUrl,
    OCR_API_TIMEOUT_MS: ocr.apiTimeoutMs,

    ENV_PROBE_TIMEOUT_MS: envProbe.timeoutMs,

    UPDATE_WORKDIR: ops.workdir ?? process.cwd(),
    UPDATE_COMMAND_TIMEOUT_MS: ops.commandTimeoutMs,
    UPDATE_REQUIRE_CLEAN_WORKTREE: ops.requireCleanWorktree,
    UPDATE_RESTART_COMMAND: ops.restartCommand,
    UPDATE_RESTART_ARGS: ops.restartArgs,
    UPDATE_RESTART_DELAY_MS: ops.restartDelayMs,
    UPDATE_RESTART_NOTICE_FILE: ops.restartNoticeFile,

    LOG_LEVEL: logging.level,
    DEBUG_AGENT_SDK_JSON: debug.agentSdkJson,
    DEBUG_MESSAGE_FLOW: debug.messageFlow,
  }
}

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'] as const

/** 把代理变量写回 process.env（Bun fetch 需要真实环境变量才能走代理）。 */
function applyProxyToEnv(json: SettingsJson): void {
  // 清理旧的大小写变体
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key]
    delete process.env[key.toLowerCase()]
  }
  if (json.transport.httpProxy) process.env.HTTP_PROXY = json.transport.httpProxy
  if (json.transport.httpsProxy) process.env.HTTPS_PROXY = json.transport.httpsProxy
  if (json.transport.noProxy) process.env.NO_PROXY = json.transport.noProxy
}

/** 加载并校验配置。读取 settings.json，fail-fast。 */
export function loadConfig(source?: Partial<SettingsJson>, opts?: { settingsPath?: string }): AppConfig {
  const filePath = opts?.settingsPath ?? SETTINGS_PATH

  let raw: Record<string, unknown>
  if (source) {
    raw = source as Record<string, unknown>
  } else {
    if (!existsSync(filePath)) {
      throw new Error(`配置文件不存在: ${path.resolve(filePath)}\n请先运行 bun setting:migrate 生成配置文件。`)
    }
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
    } catch (err) {
      throw new Error(
        `配置文件解析失败: ${path.resolve(filePath)}\n${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const parsed = SettingsJsonSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid config:\n${detail}`)
  }

  const json = parsed.data

  // 跨字段校验
  if (Boolean(json.transport.qqBotAppId) !== Boolean(json.transport.qqBotAppSecret)) {
    throw new Error('Invalid config:\n  - transport.qqBotAppId and transport.qqBotAppSecret must be set together.')
  }

  if (json.transport.whitelistUserIds.length === 0) {
    throw new Error('Invalid config:\n  - transport.whitelistUserIds must have at least one entry.')
  }

  if (!json.memory.embedding.apiKey) {
    throw new Error('Invalid config:\n  - memory.embedding.apiKey is required.')
  }

  // 展平为兼容 AppConfig
  const config = flattenSettings(json)

  // 代理变量写回 process.env（Bun fetch 依赖它）
  applyProxyToEnv(json)

  // QQ ws proxy 回退
  if (!config.QQBOT_WS_PROXY) {
    const fallback = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.ALL_PROXY
    if (fallback) config.QQBOT_WS_PROXY = fallback
  }

  return config
}
