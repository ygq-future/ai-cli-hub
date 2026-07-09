/**
 * config —— 唯一读取 process.env 的地方（Zod 强类型 + fail-fast）。
 * 契约见 docs/03-Interface-Contracts.md §6。
 *
 * 说明：本文件是全局唯一允许出现 `process.env` 的位置（eslint 规则放行 src/config/**）。
 * 任何其它模块需要配置，一律经注入的 AppConfig 获取，禁止再读 env。
 */
import { z } from 'zod'

const EnvBooleanSchema = z.preprocess(value => {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return value

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false
  return value
}, z.boolean())

export const ConfigSchema = z.object({
  // —— Telegram / 白名单 ——
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  // 逗号分隔的 user id → 去空白后的字符串数组（且至少一个非空）
  WHITELIST_USER_IDS: z
    .string()
    .min(1)
    .transform(s => s.split(',').map(x => x.trim()))
    .pipe(z.array(z.string().min(1)).min(1)),

  // —— 数据库（Postgres）——
  DATABASE_URL: z.url(), // zod v4：顶层 z.url()，旧的 z.string().url() 已弃用

  // —— 长期记忆 / 嵌入（API，不跑本地模型）——
  EMBEDDING_API_BASE_URL: z.url().default('https://api.openai.com/v1'),
  EMBEDDING_API_KEY: z.string().min(1),
  EMBEDDING_MODEL: z.string().default('BAAI/bge-m3'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
  MEMORY_RECALL_TOP_K: z.coerce.number().int().positive().default(10),
  MEMORY_SUMMARY_API_BASE_URL: z.string().default(''),
  MEMORY_SUMMARY_API_KEY: z.string().default(''),
  MEMORY_SUMMARY_MODEL: z.string().default(''),
  MEMORY_SUMMARY_MAX_CHARS: z.coerce.number().int().positive().default(600),

  // —— 生命周期超时 ——
  // 已启动的 CLI/adapter 空闲超过该时间后自动关闭；conversation 保持 idle，可再次唤醒。
  AGENT_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  SESSION_ARCHIVE_DAYS: z.coerce.number().int().positive().default(7),

  // —— 会话默认工作目录（/cwd 可切换当前用户目标目录）——
  DEFAULT_CWD: z.string().min(1).default(process.cwd()),

  // —— Agent 职责定位（注入 system hint）——
  AGENT_DESCRIPTION: z.string().default(''),
  RECENT_CONTEXT_LIMIT: z.coerce.number().int().positive().default(10),
  RECENT_CONTEXT_MESSAGE_MAX_CHARS: z.coerce.number().int().positive().default(1200),

  // —— 媒体/文件入站（M9）——
  MEDIA_DOWNLOAD_DIR: z.string().min(1).default('.data/media'),
  MEDIA_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  MEDIA_MAX_TEXT_CHARS: z.coerce.number().int().positive().default(20_000),
  MEDIA_PARSE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // —— OCR（Light OCR HTTP API；留空表示禁用 OCR）——
  OCR_API_BASE_URL: z.string().default(''),
  OCR_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // —— 日志 ——
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // —— CLI Adapter 调试 ——
  DEBUG_AGENT_SDK_JSON: EnvBooleanSchema,
})

export type AppConfig = z.infer<typeof ConfigSchema>

/** 校验输入源（默认 process.env）。抽出参数便于测试注入。 */
export type ConfigSource = Record<string, string | undefined>

/**
 * 加载并校验配置。fail-fast：启动即报错，不允许运行期"配置未定义"。
 * @param source 覆盖输入源（测试用）；默认读取 process.env（本模块唯一 env 读取点）。
 */
export function loadConfig(source: ConfigSource = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid config:\n${detail}`)
  }
  return parsed.data
}
