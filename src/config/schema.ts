/**
 * config —— 唯一读取 process.env 的地方（Zod 强类型 + fail-fast）。
 * 契约见 docs/03-Interface-Contracts.md §6。
 *
 * 说明：本文件是全局唯一允许出现 `process.env` 的位置（eslint 规则放行 src/config/**）。
 * 任何其它模块需要配置，一律经注入的 AppConfig 获取，禁止再读 env。
 */
import { z } from 'zod'

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
  EMBEDDING_API_KEY: z.string().min(1),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  MEMORY_RECALL_TOP_K: z.coerce.number().int().positive().default(6),

  // —— 生命周期超时 ——
  PTY_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  SESSION_ARCHIVE_DAYS: z.coerce.number().int().positive().default(7),

  // —— 会话默认工作目录（/cwd 命令延后至 M6b；M6 全会话共享此默认）——
  DEFAULT_CWD: z.string().min(1).default(process.cwd()),

  // —— 日志 ——
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
