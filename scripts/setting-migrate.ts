/**
 * scripts/setting-migrate.ts — 全量同步 settings.json
 *
 * 运行：bun setting:migrate  或  bun run setting:migrate
 * 也被 scripts/setting.ts import 复用（tsx/Node 兼容，不用 Bun 专有 API）
 *
 * 语义：settings.json 与 settings.json.example 完全对齐 key 结构
 *   - 双方都有的 key → 保留 settings.json 值
 *   - template 有、settings.json 无 → 写入 template 默认值
 *   - settings.json 有、template 无 → 从 settings.json 删除
 *   - 首次创建时（无 settings.json）尝试从 .env 导入旧配置值
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EXAMPLE_PATH = 'settings.json.example'
const SETTINGS_PATH = 'settings.json'
const ENV_PATH = '.env'

// 旧 env key → JSON path 映射表
export const ENV_TO_JSON_PATH: Record<string, string[]> = {
  HTTP_PROXY: ['transport', 'httpProxy'],
  HTTPS_PROXY: ['transport', 'httpsProxy'],
  NO_PROXY: ['transport', 'noProxy'],
  TELEGRAM_BOT_TOKEN: ['transport', 'telegramBotToken'],
  QQBOT_APP_ID: ['transport', 'qqBotAppId'],
  QQBOT_APP_SECRET: ['transport', 'qqBotAppSecret'],
  QQBOT_WS_PROXY: ['transport', 'qqBotWsProxy'],
  QQBOT_OPENID_DISCOVERY: ['transport', 'qqBotOpenIdDiscovery'],
  WHITELIST_USER_IDS: ['transport', 'whitelistUserIds'],
  EMBEDDING_API_BASE_URL: ['memory', 'embedding', 'apiBaseUrl'],
  EMBEDDING_API_KEY: ['memory', 'embedding', 'apiKey'],
  EMBEDDING_MODEL: ['memory', 'embedding', 'model'],
  EMBEDDING_DIMENSIONS: ['memory', 'embedding', 'dimensions'],
  MEMORY_RECALL_TOP_K: ['memory', 'recallTopK'],
  MEMORY_SUMMARY_API_BASE_URL: ['memory', 'summary', 'apiBaseUrl'],
  MEMORY_SUMMARY_API_KEY: ['memory', 'summary', 'apiKey'],
  MEMORY_SUMMARY_MODEL: ['memory', 'summary', 'model'],
  MEMORY_REQUESTED_SUMMARY_MESSAGE_LIMIT: ['memory', 'summary', 'requestedSummaryMessageLimit'],
  MEMORY_SUMMARY_MAX_CHARS: ['memory', 'summary', 'maxChars'],
  AGENT_IDLE_TIMEOUT_MS: ['lifecycle', 'agentIdleTimeoutMs'],
  AGENT_TURN_TIMEOUT_MS: ['lifecycle', 'agentTurnTimeoutMs'],
  SERVICE_SHUTDOWN_TIMEOUT_MS: ['lifecycle', 'serviceShutdownTimeoutMs'],
  SESSION_ARCHIVE_DAYS: ['lifecycle', 'sessionArchiveDays'],
  AGENT_DESCRIPTION: ['session', 'agentDescription'],
  RECENT_CONTEXT_LIMIT: ['session', 'recentContextLimit'],
  RECENT_CONTEXT_MESSAGE_MAX_CHARS: ['session', 'recentContextMessageMaxChars'],
  AGGREGATOR_DEBOUNCE_MS: ['aggregator', 'debounceMs'],
  AGGREGATOR_MIN_EDIT_INTERVAL_MS: ['aggregator', 'minEditIntervalMs'],
  AGGREGATOR_MAX_CHUNK_CHARS: ['aggregator', 'maxChunkChars'],
  MEDIA_DOWNLOAD_DIR: ['media', 'downloadDir'],
  MEDIA_MAX_FILE_BYTES: ['media', 'maxFileBytes'],
  MEDIA_MAX_TEXT_CHARS: ['media', 'maxTextChars'],
  MEDIA_PARSE_TIMEOUT_MS: ['media', 'parseTimeoutMs'],
  OCR_API_BASE_URL: ['ocr', 'apiBaseUrl'],
  OCR_API_TIMEOUT_MS: ['ocr', 'apiTimeoutMs'],
  ENV_PROBE_TIMEOUT_MS: ['envProbe', 'timeoutMs'],
  LOG_LEVEL: ['logging', 'level'],
  DEBUG_AGENT_SDK_JSON: ['debug', 'agentSdkJson'],
  DEBUG_MESSAGE_FLOW: ['debug', 'messageFlow'],
}

/** 从 env DATABASE_URL 提取 host/port/db/username/password。 */
export function parseDatabaseUrl(url: string): Record<string, unknown> {
  try {
    const u = new URL(url)
    return {
      host: u.hostname || '127.0.0.1',
      port: u.port ? Number(u.port) : 5432,
      db: u.pathname.replace(/^\//, '') || 'ai_cli_hub',
      username: u.username ? decodeURIComponent(u.username) : '',
      password: u.password ? decodeURIComponent(u.password) : '',
    }
  } catch {
    return {}
  }
}

/** env 值类型转换：按 template 对应值的类型 coerce。 */
export function coerceEnvValue(raw: string, existingTemplateValue: unknown): unknown {
  if (existingTemplateValue === null || existingTemplateValue === undefined) return raw

  if (typeof existingTemplateValue === 'boolean') {
    const v = raw.trim().toLowerCase()
    return ['1', 'true', 'yes', 'on'].includes(v) ? true : ['0', 'false', 'no', 'off', ''].includes(v) ? false : raw
  }

  if (typeof existingTemplateValue === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }

  if (Array.isArray(existingTemplateValue)) {
    return raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }

  return raw
}

/** 简易 .env 解析（不依赖 src/config/）。 */
export function parseEnvFile(filePath: string): Map<string, string> {
  const result = new Map<string, string>()
  if (!existsSync(filePath)) return result

  const text = readFileSync(filePath, 'utf-8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) result.set(key, value)
  }
  return result
}

function setNested(obj: Record<string, unknown>, p: string[], value: unknown): void {
  let current = obj
  for (let i = 0; i < p.length - 1; i++) {
    const key = p[i]!
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }
  current[p[p.length - 1]!] = value
}

export interface MigrationStats {
  preserved: number
  added: number
  deleted: number
  imported: number
}

/** 深度遍历对齐：保留 existing 值，补 template 新 key，统计 deleted。 */
export function deepMerge(
  existing: Record<string, unknown> | null,
  template: Record<string, unknown>,
): { result: Record<string, unknown>; stats: MigrationStats } {
  const stats: MigrationStats = { preserved: 0, added: 0, deleted: 0, imported: 0 }

  function walk(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    existingNode: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {}

    for (const key of Object.keys(source)) {
      const templateVal = source[key]
      const existingVal = existingNode?.[key]

      if (templateVal !== null && typeof templateVal === 'object' && !Array.isArray(templateVal)) {
        out[key] = walk(
          {},
          templateVal as Record<string, unknown>,
          existingVal && typeof existingVal === 'object' && !Array.isArray(existingVal)
            ? (existingVal as Record<string, unknown>)
            : null,
        )
      } else if (existingNode && key in existingNode) {
        out[key] = existingVal
        stats.preserved++
      } else {
        out[key] = templateVal
        stats.added++
      }
    }

    if (existingNode) {
      for (const key of Object.keys(existingNode)) {
        if (!(key in source)) stats.deleted++
      }
    }

    return out
  }

  const result = walk({}, template, existing)
  return { result, stats }
}

export interface MigrationResult {
  settings: Record<string, unknown>
  stats: MigrationStats
  /** 是否首次创建（无 settings.json）。 */
  created: boolean
  /** 是否有变更并已写盘。 */
  changed: boolean
}

/**
 * 执行 settings.json 全量同步。
 * - 读 example + existing settings.json
 * - deepMerge 对齐结构（保留值/补新/删旧）
 * - 首次创建时从 .env 导入旧配置
 * - 有变更或首次创建时写盘
 * - 返回最终 settings 与统计
 */
export function migrateSettings(opts?: {
  settingsPath?: string
  examplePath?: string
  envPath?: string
}): MigrationResult {
  const example = opts?.examplePath ?? EXAMPLE_PATH
  const settingsFile = opts?.settingsPath ?? SETTINGS_PATH
  const envFile = opts?.envPath ?? ENV_PATH

  if (!existsSync(example)) {
    throw new Error(`模板文件不存在：${path.resolve(example)}`)
  }

  const template = JSON.parse(readFileSync(example, 'utf-8')) as Record<string, unknown>
  const existing = existsSync(settingsFile)
    ? (JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>)
    : null
  const created = existing === null

  const { result, stats } = deepMerge(existing, template)

  // 首次创建时尝试从 .env 导入值
  if (created && existsSync(envFile)) {
    const envVals = parseEnvFile(envFile)

    const dbUrl = envVals.get('DATABASE_URL')
    if (dbUrl) {
      const dbParts = parseDatabaseUrl(dbUrl)
      if (Object.keys(dbParts).length > 0) {
        result.database = dbParts
        stats.imported++
      }
    }

    for (const [envKey, jsonPath] of Object.entries(ENV_TO_JSON_PATH)) {
      const envVal = envVals.get(envKey)
      if (envVal === undefined) continue
      let templateVal: unknown = template
      for (const seg of jsonPath) {
        templateVal = (templateVal as Record<string, unknown>)?.[seg]
      }
      setNested(result, jsonPath, coerceEnvValue(envVal, templateVal))
      stats.imported++
    }
  }

  const changed = created || stats.added > 0 || stats.deleted > 0 || stats.imported > 0
  if (changed) {
    writeFileSync(settingsFile, JSON.stringify(result, null, 2) + '\n')
  }

  return { settings: result, stats, created, changed }
}

function main(): void {
  try {
    const { stats, created, changed } = migrateSettings()
    if (!changed && !created) {
      console.log(`settings.json 已是最新（preserved=${stats.preserved}）`)
    } else {
      const action = created ? '已创建' : '已更新'
      console.log(
        `settings.json ${action}: preserved=${stats.preserved}, added=${stats.added}, deleted=${stats.deleted}, imported=${stats.imported}`,
      )
    }
    console.log(path.resolve(SETTINGS_PATH))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

if (import.meta.main) {
  main()
}
