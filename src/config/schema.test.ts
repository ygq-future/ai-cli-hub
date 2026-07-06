import { describe, expect, test } from 'bun:test'
import { loadConfig } from './schema'

const VALID = {
  TELEGRAM_BOT_TOKEN: 'tok',
  WHITELIST_USER_IDS: '111, 222 ,333',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  EMBEDDING_API_KEY: 'sk-x',
}

describe('loadConfig', () => {
  test('校验通过并套用默认值', () => {
    const c = loadConfig(VALID)
    expect(c.WHITELIST_USER_IDS).toEqual(['111', '222', '333'])
    expect(c.EMBEDDING_MODEL).toBe('text-embedding-3-small')
    expect(c.MEMORY_RECALL_TOP_K).toBe(6)
    expect(c.AGENT_IDLE_TIMEOUT_MS).toBe(300_000)
    expect(c.SESSION_ARCHIVE_DAYS).toBe(7)
    expect(c.LOG_LEVEL).toBe('info')
    expect(c.DEBUG_AGENT_SDK_JSON).toBe(false)
  })

  test('数值型 env 字符串被强制转换', () => {
    const c = loadConfig({ ...VALID, MEMORY_RECALL_TOP_K: '10', AGENT_IDLE_TIMEOUT_MS: '60000' })
    expect(c.MEMORY_RECALL_TOP_K).toBe(10)
    expect(c.AGENT_IDLE_TIMEOUT_MS).toBe(60000)
  })

  test('缺失必填项时 fail-fast 抛错', () => {
    expect(() => loadConfig({})).toThrow(/Invalid config/)
  })

  test('DATABASE_URL 非法 URL 时抛错', () => {
    expect(() => loadConfig({ ...VALID, DATABASE_URL: 'not-a-url' })).toThrow(/Invalid config/)
  })

  test('白名单为空字符串时抛错（至少一个 id）', () => {
    expect(() => loadConfig({ ...VALID, WHITELIST_USER_IDS: '' })).toThrow(/Invalid config/)
  })

  test('非法 LOG_LEVEL 枚举时抛错', () => {
    expect(() => loadConfig({ ...VALID, LOG_LEVEL: 'verbose' })).toThrow(/Invalid config/)
  })

  test('调试布尔 env 支持常见开关写法', () => {
    expect(loadConfig({ ...VALID, DEBUG_AGENT_SDK_JSON: 'true' }).DEBUG_AGENT_SDK_JSON).toBe(true)
    expect(loadConfig({ ...VALID, DEBUG_AGENT_SDK_JSON: '1' }).DEBUG_AGENT_SDK_JSON).toBe(true)
    expect(loadConfig({ ...VALID, DEBUG_AGENT_SDK_JSON: 'on' }).DEBUG_AGENT_SDK_JSON).toBe(true)
    expect(loadConfig({ ...VALID, DEBUG_AGENT_SDK_JSON: 'false' }).DEBUG_AGENT_SDK_JSON).toBe(false)
    expect(loadConfig({ ...VALID, DEBUG_AGENT_SDK_JSON: '0' }).DEBUG_AGENT_SDK_JSON).toBe(false)
    expect(loadConfig({ ...VALID, DEBUG_AGENT_SDK_JSON: 'off' }).DEBUG_AGENT_SDK_JSON).toBe(false)
  })

  test('非法调试布尔 env 时抛错', () => {
    expect(() => loadConfig({ ...VALID, DEBUG_AGENT_SDK_JSON: 'maybe' })).toThrow(/Invalid config/)
  })
})
