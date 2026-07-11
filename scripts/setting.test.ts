/**
 * scripts/setting.test.ts — 纯函数单元测试
 *
 * clack 的 prompt 是交互式 UI，不在此单测；这里覆盖字段定义、嵌套读写、
 * hint 格式化与 Zod 校验等可纯函数化的逻辑。
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  CATEGORIES,
  formatHint,
  getNested,
  parseNumberedChoice,
  runWindowsLineEditor,
  setNested,
  validateSettings,
} from './setting'
import { migrateSettings } from './setting-migrate'

const settings = JSON.parse(readFileSync('settings.json.example', 'utf-8')) as Record<string, unknown>

describe('CATEGORIES 字段定义', () => {
  test('13 个分类', () => {
    expect(CATEGORIES).toHaveLength(13)
  })

  test('每个字段有合法 jsonPath 与 typeTag', () => {
    for (const cat of CATEGORIES) {
      expect(cat.key).toBeTruthy()
      expect(cat.label).toBeTruthy()
      expect(cat.fields.length).toBeGreaterThan(0)
      for (const f of cat.fields) {
        expect(f.jsonPath.length).toBeGreaterThanOrEqual(2)
        expect(f.typeTag).toBeTruthy()
        if (f.type === 'enum') expect(f.enumValues?.length).toBeGreaterThan(0)
      }
    }
  })

  test('所有 jsonPath 指向 example 中存在的键', () => {
    for (const cat of CATEGORIES) {
      for (const f of cat.fields) {
        // 沿路径走，example 应包含（可为空值）
        let cur: unknown = settings
        for (const seg of f.jsonPath) {
          expect(cur).toBeTypeOf('object')
          cur = (cur as Record<string, unknown>)[seg]
        }
      }
    }
  })
})

describe('getNested / setNested', () => {
  test('读取嵌套值', () => {
    expect(getNested(settings, ['database', 'host'])).toBe('127.0.0.1')
    expect(getNested(settings, ['memory', 'embedding', 'model'])).toBe('BAAI/bge-m3')
    expect(getNested(settings, ['logging', 'level'])).toBe('info')
  })

  test('读取不存在的路径返回 undefined', () => {
    expect(getNested(settings, ['nope', 'x'])).toBeUndefined()
    expect(getNested(settings, ['database', 'nope'])).toBeUndefined()
  })

  test('写入嵌套值并读回', () => {
    const obj = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
    setNested(obj, ['database', 'port'], 6543)
    expect(getNested(obj, ['database', 'port'])).toBe(6543)
    setNested(obj, ['memory', 'embedding', 'apiKey'], 'sk-new')
    expect(getNested(obj, ['memory', 'embedding', 'apiKey'])).toBe('sk-new')
  })

  test('写入时自动创建中间对象', () => {
    const obj: Record<string, unknown> = {}
    setNested(obj, ['a', 'b', 'c'], 1)
    expect(getNested(obj, ['a', 'b', 'c'])).toBe(1)
  })
})

describe('formatHint', () => {
  test('null/undefined → (null)', () => {
    expect(formatHint(null, 'string')).toBe('(null)')
    expect(formatHint(undefined, 'number')).toBe('(null)')
  })

  test('空字符串 → (空)', () => {
    expect(formatHint('', 'string')).toBe('(空)')
  })

  test('password 非空显示掩码与长度', () => {
    expect(formatHint('sk-abc', 'password')).toBe('••••••（6 位）')
    expect(formatHint('', 'password')).toBe('(空)')
  })

  test('boolean 显示是/否', () => {
    expect(formatHint(true, 'boolean')).toBe('是')
    expect(formatHint(false, 'boolean')).toBe('否')
  })

  test('数组空显示 (空)，有值 join', () => {
    expect(formatHint([], 'string[]')).toBe('(空)')
    expect(formatHint(['a', 'b'], 'string[]')).toBe('a, b')
  })

  test('长值截断', () => {
    const long = 'x'.repeat(100)
    const hint = formatHint(long, 'string')
    expect(hint.length).toBeLessThan(long.length)
    expect(hint.endsWith('…')).toBe(true)
  })

  test('enum 显示原值', () => {
    expect(formatHint('warn', 'enum')).toBe('warn')
  })
})

describe('validateSettings', () => {
  test('example 配置结构有效', () => {
    expect(validateSettings(settings)).toBeNull()
  })

  test('破坏结构后校验失败', () => {
    const bad = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
    bad.database = 'not-an-object'
    expect(validateSettings(bad)).not.toBeNull()
  })

  test('端口非数字校验失败', () => {
    const bad = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
    const db = bad.database as Record<string, unknown>
    db.port = 'not-a-port'
    expect(validateSettings(bad)).not.toBeNull()
  })

  test('日志 level 非 enum 值校验失败', () => {
    const bad = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
    const log = bad.logging as Record<string, unknown>
    log.level = 'verbose'
    expect(validateSettings(bad)).not.toBeNull()
  })
})

describe('Windows 单 readline 稳定模式', () => {
  test('解析编号、返回别名与无效输入', () => {
    expect(parseNumberedChoice('1', 3)).toBe(1)
    expect(parseNumberedChoice(' 3 ', 3)).toBe(3)
    expect(parseNumberedChoice('0', 3)).toBe(0)
    expect(parseNumberedChoice('q', 3)).toBe(0)
    expect(parseNumberedChoice('back', 3)).toBe(0)
    expect(parseNumberedChoice('4', 3)).toBeNull()
    expect(parseNumberedChoice('x', 3)).toBeNull()
  })

  test('使用同一 IO 完成进分类、编辑字符串、返回和退出', async () => {
    const edited = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
    const answers = ['1', '1', 'http://127.0.0.1:7890', '0', '0']
    const output: string[] = []
    let saveCount = 0

    await runWindowsLineEditor(
      edited,
      {
        question: async () => answers.shift() ?? '0',
        write: text => output.push(text),
      },
      () => saveCount++,
    )

    expect(getNested(edited, ['transport', 'httpProxy'])).toBe('http://127.0.0.1:7890')
    expect(saveCount).toBe(1)
    expect(output.join('')).toContain('Windows 稳定模式')
    expect(output.join('')).toContain('HTTP Proxy 已保存')
  })

  test('无效数字会重试，布尔值与枚举可以编辑', async () => {
    const edited = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
    const answers = ['2', '2', 'not-a-number', '6543', '0', '1', '8', 'n', '0', '12', '1', '3', '0', '0']
    let saveCount = 0

    await runWindowsLineEditor(
      edited,
      {
        question: async () => answers.shift() ?? '0',
        write: () => undefined,
      },
      () => saveCount++,
    )

    expect(getNested(edited, ['database', 'port'])).toBe(6543)
    expect(getNested(edited, ['transport', 'qqBotOpenIdDiscovery'])).toBe(false)
    expect(getNested(edited, ['logging', 'level'])).toBe('warn')
    expect(saveCount).toBe(3)
  })
})

describe('migrateSettings', () => {
  const tmp = '.tmp-migrate-test'

  function cleanup(): void {
    rmSync(tmp, { recursive: true, force: true })
  }

  test('首次创建从 .env 导入（DATABASE_URL 拆分 + env key 映射 + 类型 coerce）', () => {
    cleanup()
    mkdirSync(tmp, { recursive: true })
    writeFileSync(
      `${tmp}/settings.json.example`,
      JSON.stringify({
        transport: { telegramBotToken: '', whitelistUserIds: [] as string[] },
        database: { host: '127.0.0.1', port: 5432, db: 'x', username: '', password: '' },
        logging: { level: 'info' },
      }),
    )
    writeFileSync(
      `${tmp}/.env`,
      'TELEGRAM_BOT_TOKEN=abc123\n' +
        'DATABASE_URL=postgres://hub:pw@localhost:5432/ai_cli_hub\n' +
        'LOG_LEVEL=warn\n' +
        'WHITELIST_USER_IDS=111,222\n',
    )

    const r = migrateSettings({
      examplePath: `${tmp}/settings.json.example`,
      settingsPath: `${tmp}/settings.json`,
      envPath: `${tmp}/.env`,
    })

    expect(r.created).toBe(true)
    expect(r.stats.imported).toBeGreaterThan(0)
    expect(getNested(r.settings, ['transport', 'telegramBotToken'])).toBe('abc123')
    expect(getNested(r.settings, ['database', 'host'])).toBe('localhost')
    expect(getNested(r.settings, ['database', 'password'])).toBe('pw')
    expect(getNested(r.settings, ['database', 'port'])).toBe(5432)
    expect(getNested(r.settings, ['logging', 'level'])).toBe('warn')
    expect(getNested(r.settings, ['transport', 'whitelistUserIds'])).toEqual(['111', '222'])
    // 写盘了
    expect(readFileSync(`${tmp}/settings.json`, 'utf-8')).toContain('abc123')

    cleanup()
  })

  test('已存在 settings.json 时保留值、不导入 .env', () => {
    cleanup()
    mkdirSync(tmp, { recursive: true })
    writeFileSync(
      `${tmp}/settings.json.example`,
      JSON.stringify({ transport: { telegramBotToken: '' }, logging: { level: 'info' } }),
    )
    writeFileSync(
      `${tmp}/settings.json`,
      JSON.stringify({ transport: { telegramBotToken: 'existing-token' }, logging: { level: 'error' } }),
    )
    writeFileSync(`${tmp}/.env`, 'TELEGRAM_BOT_TOKEN=should-not-import\nLOG_LEVEL=debug\n')

    const r = migrateSettings({
      examplePath: `${tmp}/settings.json.example`,
      settingsPath: `${tmp}/settings.json`,
      envPath: `${tmp}/.env`,
    })

    expect(r.created).toBe(false)
    expect(r.stats.imported).toBe(0)
    expect(getNested(r.settings, ['transport', 'telegramBotToken'])).toBe('existing-token')
    expect(getNested(r.settings, ['logging', 'level'])).toBe('error')

    cleanup()
  })

  test('example 新增 key 时补默认值', () => {
    cleanup()
    mkdirSync(tmp, { recursive: true })
    writeFileSync(
      `${tmp}/settings.json.example`,
      JSON.stringify({ transport: { telegramBotToken: '', qqBotAppId: '' }, logging: { level: 'info' } }),
    )
    writeFileSync(
      `${tmp}/settings.json`,
      JSON.stringify({ transport: { telegramBotToken: 'kept' }, logging: { level: 'info' } }),
    )

    const r = migrateSettings({
      examplePath: `${tmp}/settings.json.example`,
      settingsPath: `${tmp}/settings.json`,
      envPath: `${tmp}/.env`,
    })

    expect(r.stats.added).toBe(1)
    expect(getNested(r.settings, ['transport', 'telegramBotToken'])).toBe('kept')
    expect(getNested(r.settings, ['transport', 'qqBotAppId'])).toBe('')

    cleanup()
  })
})
