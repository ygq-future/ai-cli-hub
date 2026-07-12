/**
 * scripts/setting.ts — 交互式 settings.json 编辑器（@clack/prompts）
 *
 * 运行：bun setting（底层用 tsx→Node 跑，避开 Bun 的 readline.emitKeypressEvents 兼容问题）
 *
 * 导航：Linux 使用 Clack 方向键菜单；Windows 使用单 readline 实例的编号菜单
 * 退出：Linux 选"退出"或 ESC/Ctrl+C；Windows 输入 0/q 返回或退出
 * 保存：每次编辑确认后立即写盘；校验状态显示在主菜单与退出提示
 */
import * as p from '@clack/prompts'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { SettingsJsonSchema } from '../src/config/schema'
import { migrateSettings } from './setting-migrate'

const EXAMPLE_PATH = 'settings.json.example'
const SETTINGS_PATH = 'settings.json'

// ─── 类型与字段定义 ───────────────────────────────────────────────

export type FieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'enum' | 'password'

export interface FieldDef {
  jsonPath: string[]
  label: string
  type: FieldType
  typeTag: string
  enumValues?: string[]
}

export interface CategoryDef {
  key: string
  label: string
  fields: FieldDef[]
}

export interface LineEditorIo {
  question(prompt: string): Promise<string>
  write(text: string): void
}

export const CATEGORIES: CategoryDef[] = [
  {
    key: 'transport',
    label: 'Transport 传输与白名单',
    fields: [
      { jsonPath: ['transport', 'httpProxy'], label: 'HTTP Proxy', type: 'string', typeTag: 'str' },
      { jsonPath: ['transport', 'httpsProxy'], label: 'HTTPS Proxy', type: 'string', typeTag: 'str' },
      { jsonPath: ['transport', 'noProxy'], label: 'NO Proxy', type: 'string', typeTag: 'str' },
      { jsonPath: ['transport', 'telegramBotToken'], label: 'Telegram Bot Token', type: 'password', typeTag: 'secret' },
      { jsonPath: ['transport', 'qqBotAppId'], label: 'QQ Bot App ID', type: 'string', typeTag: 'str' },
      { jsonPath: ['transport', 'qqBotAppSecret'], label: 'QQ Bot App Secret', type: 'password', typeTag: 'secret' },
      { jsonPath: ['transport', 'qqBotWsProxy'], label: 'QQ Bot WS Proxy', type: 'string', typeTag: 'str' },
      {
        jsonPath: ['transport', 'qqBotOpenIdDiscovery'],
        label: 'QQ OpenID Discovery',
        type: 'boolean',
        typeTag: 'bool',
      },
      { jsonPath: ['transport', 'whitelistUserIds'], label: 'Whitelist User IDs', type: 'string[]', typeTag: 'list' },
    ],
  },
  {
    key: 'database',
    label: 'Database 数据库',
    fields: [
      { jsonPath: ['database', 'host'], label: 'Host', type: 'string', typeTag: 'str' },
      { jsonPath: ['database', 'port'], label: 'Port', type: 'number', typeTag: 'num' },
      { jsonPath: ['database', 'db'], label: 'Database Name', type: 'string', typeTag: 'str' },
      { jsonPath: ['database', 'username'], label: 'Username', type: 'string', typeTag: 'str' },
      { jsonPath: ['database', 'password'], label: 'Password', type: 'password', typeTag: 'secret' },
    ],
  },
  {
    key: 'memory.embedding',
    label: 'Memory · Embedding 嵌入',
    fields: [
      { jsonPath: ['memory', 'embedding', 'apiBaseUrl'], label: 'API Base URL', type: 'string', typeTag: 'str' },
      { jsonPath: ['memory', 'embedding', 'apiKey'], label: 'API Key', type: 'password', typeTag: 'secret' },
      { jsonPath: ['memory', 'embedding', 'model'], label: 'Model', type: 'string', typeTag: 'str' },
      { jsonPath: ['memory', 'embedding', 'dimensions'], label: 'Dimensions', type: 'number', typeTag: 'num' },
      { jsonPath: ['memory', 'recallTopK'], label: 'Recall Top-K', type: 'number', typeTag: 'num' },
    ],
  },
  {
    key: 'memory.summary',
    label: 'Memory · Summary 摘要',
    fields: [
      { jsonPath: ['memory', 'summary', 'apiBaseUrl'], label: 'API Base URL', type: 'string', typeTag: 'str' },
      { jsonPath: ['memory', 'summary', 'apiKey'], label: 'API Key', type: 'password', typeTag: 'secret' },
      { jsonPath: ['memory', 'summary', 'model'], label: 'Model', type: 'string', typeTag: 'str' },
      {
        jsonPath: ['memory', 'summary', 'requestedSummaryMessageLimit'],
        label: 'Summary Msg Limit',
        type: 'number',
        typeTag: 'num',
      },
      { jsonPath: ['memory', 'summary', 'maxChars'], label: 'Summary Max Chars', type: 'number', typeTag: 'num' },
    ],
  },
  {
    key: 'lifecycle',
    label: 'Lifecycle 生命周期',
    fields: [
      { jsonPath: ['lifecycle', 'agentIdleTimeoutMs'], label: 'Agent Idle Timeout', type: 'number', typeTag: 'ms' },
      { jsonPath: ['lifecycle', 'agentTurnTimeoutMs'], label: 'Agent Turn Timeout', type: 'number', typeTag: 'ms' },
      { jsonPath: ['lifecycle', 'serviceShutdownTimeoutMs'], label: 'Shutdown Timeout', type: 'number', typeTag: 'ms' },
      { jsonPath: ['lifecycle', 'sessionArchiveDays'], label: 'Session Archive Days', type: 'number', typeTag: 'num' },
    ],
  },
  {
    key: 'session',
    label: 'Session 会话',
    fields: [
      { jsonPath: ['session', 'defaultCwd'], label: 'Default CWD', type: 'string', typeTag: 'str' },
      { jsonPath: ['session', 'agentDescription'], label: 'Agent Description', type: 'string', typeTag: 'str' },
      { jsonPath: ['session', 'recentContextLimit'], label: 'Recent Context Limit', type: 'number', typeTag: 'num' },
      {
        jsonPath: ['session', 'recentContextMessageMaxChars'],
        label: 'Recent Context Max Chars',
        type: 'number',
        typeTag: 'num',
      },
    ],
  },
  {
    key: 'aggregator',
    label: 'Aggregator 消息聚合',
    fields: [
      { jsonPath: ['aggregator', 'debounceMs'], label: 'Debounce', type: 'number', typeTag: 'ms' },
      { jsonPath: ['aggregator', 'minEditIntervalMs'], label: 'Min Edit Interval', type: 'number', typeTag: 'ms' },
      { jsonPath: ['aggregator', 'maxChunkChars'], label: 'Max Chunk Chars', type: 'number', typeTag: 'num' },
    ],
  },
  {
    key: 'media',
    label: 'Media 媒体',
    fields: [
      { jsonPath: ['media', 'downloadDir'], label: 'Download Dir', type: 'string', typeTag: 'str' },
      { jsonPath: ['media', 'maxFileBytes'], label: 'Max File Bytes', type: 'number', typeTag: 'num' },
      { jsonPath: ['media', 'maxTextChars'], label: 'Max Text Chars', type: 'number', typeTag: 'num' },
      { jsonPath: ['media', 'parseTimeoutMs'], label: 'Parse Timeout', type: 'number', typeTag: 'ms' },
    ],
  },
  {
    key: 'ocr',
    label: 'OCR 光学识别',
    fields: [
      { jsonPath: ['ocr', 'apiBaseUrl'], label: 'API Base URL', type: 'string', typeTag: 'str' },
      { jsonPath: ['ocr', 'apiTimeoutMs'], label: 'API Timeout', type: 'number', typeTag: 'ms' },
    ],
  },
  {
    key: 'envProbe',
    label: 'Env Probe 环境探测',
    fields: [{ jsonPath: ['envProbe', 'timeoutMs'], label: 'Timeout', type: 'number', typeTag: 'ms' }],
  },
  {
    key: 'ops',
    label: 'Ops 运维自更新',
    fields: [
      { jsonPath: ['ops', 'workdir'], label: 'Workdir', type: 'string', typeTag: 'str' },
      { jsonPath: ['ops', 'commandTimeoutMs'], label: 'Command Timeout', type: 'number', typeTag: 'ms' },
      { jsonPath: ['ops', 'requireCleanWorktree'], label: 'Require Clean Worktree', type: 'boolean', typeTag: 'bool' },
      { jsonPath: ['ops', 'restartCommand'], label: 'Restart Command', type: 'string', typeTag: 'str' },
      { jsonPath: ['ops', 'restartArgs'], label: 'Restart Args', type: 'string[]', typeTag: 'list' },
      { jsonPath: ['ops', 'restartDelayMs'], label: 'Restart Delay', type: 'number', typeTag: 'ms' },
      { jsonPath: ['ops', 'restartNoticeFile'], label: 'Restart Notice File', type: 'string', typeTag: 'str' },
    ],
  },
  {
    key: 'logging',
    label: 'Logging 日志',
    fields: [
      {
        jsonPath: ['logging', 'level'],
        label: 'Level',
        type: 'enum',
        typeTag: 'enum',
        enumValues: ['debug', 'info', 'warn', 'error'],
      },
    ],
  },
  {
    key: 'debug',
    label: 'Debug 调试',
    fields: [
      { jsonPath: ['debug', 'agentSdkJson'], label: 'Agent SDK JSON', type: 'boolean', typeTag: 'bool' },
      { jsonPath: ['debug', 'messageFlow'], label: 'Message Flow', type: 'boolean', typeTag: 'bool' },
    ],
  },
]

// ─── 工具函数 ─────────────────────────────────────────────────────

export function getNested(obj: Record<string, unknown>, p: string[]): unknown {
  let cur: unknown = obj
  for (const seg of p) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

export function setNested(obj: Record<string, unknown>, p: string[], value: unknown): void {
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < p.length - 1; i++) {
    const key = p[i]!
    if (!(key in cur) || typeof cur[key] !== 'object' || cur[key] === null) {
      cur[key] = {}
    }
    cur = cur[key] as Record<string, unknown>
  }
  cur[p[p.length - 1]!] = value
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

/** 字段当前值的简短展示（用于 select 的 hint，不带 ANSI 颜色，clack 自行着色）。 */
export function formatHint(val: unknown, type: FieldType): string {
  if (val === null || val === undefined) return '(null)'
  if (type === 'password' && typeof val === 'string') {
    return val ? `••••••（${val.length} 位）` : '(空)'
  }
  if (type === 'boolean') return val ? '是' : '否'
  if (Array.isArray(val)) {
    if (!val.length) return '(空)'
    return truncate(val.join(', '), 40)
  }
  if (val === '') return '(空)'
  return truncate(String(val), 40)
}

async function runPrompt<T>(prompt: Promise<T>): Promise<T> {
  return prompt
}

// ─── 校验 ─────────────────────────────────────────────────────────

export function validateSettings(settings: Record<string, unknown>): string | null {
  const r = SettingsJsonSchema.safeParse(settings)
  if (!r.success) {
    const first = r.error.issues[0]
    return first ? `${first.path.join('.') || '(root)'}: ${first.message}` : '配置结构不合法'
  }
  return null
}

// ─── 持久化 ───────────────────────────────────────────────────────

/**
 * 启动时执行全量同步：对齐 example 结构（补新 key/删旧 key），
 * 首次创建时复制 settings.json.example 默认值。返回 settings 与变更信息。
 */
function loadSettings(): {
  settings: Record<string, unknown>
  created: boolean
  changed: boolean
} {
  const { settings, created, changed } = migrateSettings()
  return { settings, created, changed }
}

function saveSettings(settings: Record<string, unknown>): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
}

/** Windows cooked-mode 编号输入：0 表示返回/退出，null 表示无效。 */
export function parseNumberedChoice(input: string, itemCount: number): number | null {
  const normalized = input.trim().toLowerCase()
  if (normalized === 'q' || normalized === 'quit' || normalized === 'back') return 0
  if (!/^\d+$/.test(normalized)) return null
  const choice = Number(normalized)
  return Number.isInteger(choice) && choice >= 0 && choice <= itemCount ? choice : null
}

async function askNumberedMenu(io: LineEditorIo, title: string, items: string[], zeroLabel: string): Promise<number> {
  io.write(`\n${title}\n`)
  items.forEach((item, index) => io.write(`  ${index + 1}. ${item}\n`))
  io.write(`  0. ${zeroLabel}\n`)

  while (true) {
    const choice = parseNumberedChoice(await io.question('请输入编号: '), items.length)
    if (choice !== null) return choice
    io.write(`无效编号，请输入 0-${items.length}。\n`)
  }
}

async function editFieldWithLineInput(
  f: FieldDef,
  settings: Record<string, unknown>,
  io: LineEditorIo,
): Promise<boolean> {
  const cur = getNested(settings, f.jsonPath)
  io.write(`\n${f.label} (${f.typeTag})\n当前值: ${formatHint(cur, f.type)}\n`)

  if (f.type === 'boolean') {
    while (true) {
      const answer = (await io.question('新值 [y/n]（留空取消）: ')).trim().toLowerCase()
      if (!answer) return false
      if (['y', 'yes', '1', 'true'].includes(answer)) {
        setNested(settings, f.jsonPath, true)
        return true
      }
      if (['n', 'no', '0', 'false'].includes(answer)) {
        setNested(settings, f.jsonPath, false)
        return true
      }
      io.write('请输入 y 或 n。\n')
    }
  }

  if (f.type === 'enum' && f.enumValues) {
    const choice = await askNumberedMenu(io, '选择新值', f.enumValues, '取消')
    if (choice === 0) return false
    setNested(settings, f.jsonPath, f.enumValues[choice - 1])
    return true
  }

  if (f.type === 'password') {
    io.write('注意：Windows 稳定模式不使用 raw mode，新密码会显示在当前终端。\n')
  }

  while (true) {
    const answer = await io.question('输入新值（留空取消）: ')
    if (!answer.trim()) return false

    if (f.type === 'number') {
      const value = Number(answer.trim())
      if (!Number.isFinite(value)) {
        io.write('请输入有效数字。\n')
        continue
      }
      setNested(settings, f.jsonPath, value)
      return true
    }

    if (f.type === 'string[]') {
      setNested(
        settings,
        f.jsonPath,
        answer
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
      )
      return true
    }

    setNested(settings, f.jsonPath, answer)
    return true
  }
}

/** Windows 稳定模式：整个编辑会话由同一个 cooked-mode readline interface 驱动。 */
export async function runWindowsLineEditor(
  settings: Record<string, unknown>,
  io: LineEditorIo,
  persist: (value: Record<string, unknown>) => void = saveSettings,
): Promise<void> {
  while (true) {
    const valErr = validateSettings(settings)
    const categoryChoice = await askNumberedMenu(
      io,
      `settings.json 配置编辑器 · Windows 稳定模式${valErr ? ` · ⚠ ${truncate(valErr, 50)}` : ''}`,
      CATEGORIES.map(category => `${category.label} (${category.fields.length} 项)`),
      '退出',
    )
    if (categoryChoice === 0) {
      io.write(valErr ? `\n已退出。当前配置校验错误: ${valErr}\n` : `\n已保存到 ${path.resolve(SETTINGS_PATH)}\n`)
      return
    }

    const category = CATEGORIES[categoryChoice - 1]!
    while (true) {
      const fieldChoice = await askNumberedMenu(
        io,
        category.label,
        category.fields.map(
          field => `${field.label} [${field.typeTag}] · ${formatHint(getNested(settings, field.jsonPath), field.type)}`,
        ),
        '返回分类列表',
      )
      if (fieldChoice === 0) break

      const field = category.fields[fieldChoice - 1]!
      const changed = await editFieldWithLineInput(field, settings, io)
      if (!changed) {
        io.write('已取消，未修改。\n')
        continue
      }

      persist(settings)
      const error = validateSettings(settings)
      io.write(error ? `已保存，但配置校验未通过: ${error}\n` : `${field.label} 已保存。\n`)
    }
  }
}

// ─── 交互 ─────────────────────────────────────────────────────────

async function editField(f: FieldDef, settings: Record<string, unknown>): Promise<boolean> {
  const cur = getNested(settings, f.jsonPath)
  const curDisp = formatHint(cur, f.type)
  const title = `${f.label} (${f.typeTag})`

  if (f.type === 'boolean') {
    const v = await runPrompt(
      p.confirm({
        message: `${title} · 当前: ${curDisp}`,
        initialValue: Boolean(cur),
        active: '是',
        inactive: '否',
      }),
    )
    if (p.isCancel(v)) return false
    setNested(settings, f.jsonPath, v)
    return true
  }

  if (f.type === 'enum' && f.enumValues) {
    const v = await runPrompt(
      p.select({
        message: title,
        initialValue: String(cur ?? f.enumValues[0] ?? ''),
        options: f.enumValues.map(ev => ({
          value: ev,
          label: ev,
          hint: ev === String(cur) ? '当前' : undefined,
        })),
      }),
    )
    if (p.isCancel(v)) return false
    setNested(settings, f.jsonPath, v)
    return true
  }

  if (f.type === 'number') {
    const v = await runPrompt(
      p.text({
        message: `${title} · 当前: ${curDisp}`,
        defaultValue: cur !== null && cur !== undefined ? String(cur) : '',
        placeholder: '输入数字（留空保留原值）',
        validate: s => (s && s.trim() && !Number.isFinite(Number(s)) ? '请输入有效数字' : undefined),
      }),
    )
    if (p.isCancel(v)) return false
    if (v.trim()) setNested(settings, f.jsonPath, Number(v))
    return true
  }

  if (f.type === 'string[]') {
    const v = await runPrompt(
      p.text({
        message: `${title} · 逗号分隔 · 当前: ${curDisp}`,
        defaultValue: Array.isArray(cur) ? cur.join(', ') : '',
        placeholder: '如: 11111111, qq-openid',
      }),
    )
    if (p.isCancel(v)) return false
    setNested(
      settings,
      f.jsonPath,
      v
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    )
    return true
  }

  if (f.type === 'password') {
    const v = await runPrompt(
      p.password({
        message: `${title} · 当前: ${curDisp}（留空保留原值）`,
      }),
    )
    if (p.isCancel(v)) return false
    if (v.trim()) setNested(settings, f.jsonPath, v)
    return true
  }

  // string
  const v = await runPrompt(
    p.text({
      message: `${title} · 当前: ${curDisp}`,
      defaultValue: typeof cur === 'string' ? cur : '',
      placeholder: '输入新值（留空保留原值）',
    }),
  )
  if (p.isCancel(v)) return false
  setNested(settings, f.jsonPath, v)
  return true
}

async function editCategory(cat: CategoryDef, settings: Record<string, unknown>): Promise<void> {
  while (true) {
    const fieldChoice = await runPrompt(
      p.select({
        message: cat.label,
        options: [
          ...cat.fields.map(f => ({
            value: f.jsonPath.join('.'),
            label: f.label,
            hint: `${f.typeTag} · ${formatHint(getNested(settings, f.jsonPath), f.type)}`,
          })),
          { value: '__back', label: '← 返回分类列表' },
        ],
      }),
    )

    if (p.isCancel(fieldChoice) || fieldChoice === '__back') return

    const f = cat.fields.find(x => x.jsonPath.join('.') === fieldChoice)
    if (!f) return

    const ok = await editField(f, settings)
    if (ok) {
      saveSettings(settings)
      const valErr = validateSettings(settings)
      if (valErr) {
        p.log.warn(`已保存，但配置校验未通过：${valErr}`)
      } else {
        p.log.success(`${f.label} 已保存`)
      }
    } else {
      p.log.message('已取消，未修改')
    }
  }
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('此命令需要在交互式终端中运行（检测到 stdin 非 TTY）。')
    console.error('请在终端中直接执行：bun setting')
    process.exit(1)
  }
  if (!existsSync(EXAMPLE_PATH)) {
    console.error(`模板文件不存在：${path.resolve(EXAMPLE_PATH)}`)
    process.exit(1)
  }

  const { settings, created, changed } = loadSettings()

  if (process.platform === 'win32') {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const io: LineEditorIo = {
      question: prompt => rl.question(prompt),
      write: text => process.stdout.write(text),
    }
    try {
      if (created) io.write('首次创建 settings.json，已从 settings.json.example 生成初始配置。\n')
      else if (changed) io.write('settings.json 已同步最新结构（补新 key / 删旧 key）。\n')
      await runWindowsLineEditor(settings, io)
    } finally {
      rl.close()
    }
    return
  }

  p.intro('settings.json 配置编辑器')

  if (created) {
    p.log.info('首次创建 settings.json，已从 settings.json.example 生成初始配置')
  } else if (changed) {
    p.log.info('settings.json 已同步最新结构（补新 key / 删旧 key）')
  }

  const hadErr = validateSettings(settings)
  if (hadErr) {
    p.log.warn(`当前配置校验未通过：${hadErr}`)
  }

  while (true) {
    const valErr = validateSettings(settings)
    const exitLabel = valErr ? `退出（⚠ ${truncate(valErr, 36)}）` : '退出'

    const catChoice = await runPrompt(
      p.select({
        message: '选择配置分类',
        options: [
          ...CATEGORIES.map(c => ({
            value: c.key,
            label: c.label,
            hint: `${c.fields.length} 项`,
          })),
          { value: '__exit', label: exitLabel, hint: '⏎' },
        ],
      }),
    )

    if (p.isCancel(catChoice)) {
      p.outro('已退出（改动已随编辑保存）')
      return
    }
    if (catChoice === '__exit') {
      p.outro(valErr ? `已保存 · ⚠ ${valErr}` : `已保存到 ${path.resolve(SETTINGS_PATH)}`)
      return
    }

    const cat = CATEGORIES.find(c => c.key === catChoice)
    if (!cat) continue
    await editCategory(cat, settings)
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error('配置编辑器异常:', err)
    process.exitCode = 1
  })
}
