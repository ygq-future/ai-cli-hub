/**
 * scripts/setting-migrate.ts —— 全量同步 settings.json
 *
 * 运行：bun setting:migrate  或  bun run setting:migrate
 * 也被 scripts/setting.ts import 复用（tsx/Node 兼容，不用 Bun 专有 API）。
 *
 * 语义：settings.json 与 settings.json.example 完全对齐 key 结构
 *   - 双方都有的 key → 保留 settings.json 值
 *   - template 有、settings.json 无 → 写入 template 默认值
 *   - settings.json 有、template 无 → 从 settings.json 删除
 *   - 首次创建 → 直接使用 settings.json.example 默认值
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EXAMPLE_PATH = 'settings.json.example'
const SETTINGS_PATH = 'settings.json'

export interface MigrationStats {
  preserved: number
  added: number
  deleted: number
}

/** 深度遍历对齐：保留 existing 值，补 template 新 key，统计 deleted。 */
export function deepMerge(
  existing: Record<string, unknown> | null,
  template: Record<string, unknown>,
): { result: Record<string, unknown>; stats: MigrationStats } {
  const stats: MigrationStats = { preserved: 0, added: 0, deleted: 0 }

  function walk(
    source: Record<string, unknown>,
    existingNode: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {}

    for (const key of Object.keys(source)) {
      const templateVal = source[key]
      const existingVal = existingNode?.[key]

      if (templateVal !== null && typeof templateVal === 'object' && !Array.isArray(templateVal)) {
        out[key] = walk(
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

  return { result: walk(template, existing), stats }
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
 * - 有变更或首次创建时写盘
 * - 返回最终 settings 与统计
 */
export function migrateSettings(opts?: { settingsPath?: string; examplePath?: string }): MigrationResult {
  const example = opts?.examplePath ?? EXAMPLE_PATH
  const settingsFile = opts?.settingsPath ?? SETTINGS_PATH

  if (!existsSync(example)) {
    throw new Error(`模板文件不存在：${path.resolve(example)}`)
  }

  const template = JSON.parse(readFileSync(example, 'utf-8')) as Record<string, unknown>
  const existing = existsSync(settingsFile)
    ? (JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>)
    : null
  const created = existing === null
  const { result, stats } = deepMerge(existing, template)
  const changed = created || stats.added > 0 || stats.deleted > 0

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
        `settings.json ${action}: preserved=${stats.preserved}, added=${stats.added}, deleted=${stats.deleted}`,
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
