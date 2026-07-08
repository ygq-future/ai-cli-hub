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
    expect(c.AGENT_DESCRIPTION).toBe('')
    expect(c.MEDIA_DOWNLOAD_DIR).toBe('.data/media')
    expect(c.MEDIA_MAX_FILE_BYTES).toBe(10 * 1024 * 1024)
    expect(c.MEDIA_MAX_TEXT_CHARS).toBe(20_000)
    expect(c.MEDIA_PARSE_TIMEOUT_MS).toBe(30_000)
    expect(c.OCR_API_BASE_URL).toBe('')
    expect(c.OCR_API_TIMEOUT_MS).toBe(30_000)
    expect(c.LOG_LEVEL).toBe('info')
    expect(c.DEBUG_AGENT_SDK_JSON).toBe(false)
  })

  test('AGENT_DESCRIPTION 从 env 读取', () => {
    const c = loadConfig({ ...VALID, AGENT_DESCRIPTION: '负责远程管理个人 VPS 上的 AI CLI 会话。' })
    expect(c.AGENT_DESCRIPTION).toBe('负责远程管理个人 VPS 上的 AI CLI 会话。')
  })

  test('数值型 env 字符串被强制转换', () => {
    const c = loadConfig({ ...VALID, MEMORY_RECALL_TOP_K: '10', AGENT_IDLE_TIMEOUT_MS: '60000' })
    expect(c.MEMORY_RECALL_TOP_K).toBe(10)
    expect(c.AGENT_IDLE_TIMEOUT_MS).toBe(60000)
  })

  test('媒体限制 env 字符串被强制转换', () => {
    const c = loadConfig({
      ...VALID,
      MEDIA_DOWNLOAD_DIR: 'D:/hub-media',
      MEDIA_MAX_FILE_BYTES: '1024',
      MEDIA_MAX_TEXT_CHARS: '2048',
      MEDIA_PARSE_TIMEOUT_MS: '5000',
    })
    expect(c.MEDIA_DOWNLOAD_DIR).toBe('D:/hub-media')
    expect(c.MEDIA_MAX_FILE_BYTES).toBe(1024)
    expect(c.MEDIA_MAX_TEXT_CHARS).toBe(2048)
    expect(c.MEDIA_PARSE_TIMEOUT_MS).toBe(5000)
  })

  test('OCR API 配置从 env 读取并转换超时', () => {
    const c = loadConfig({
      ...VALID,
      OCR_API_BASE_URL: 'http://localhost:8000',
      OCR_API_TIMEOUT_MS: '15000',
    })
    expect(c.OCR_API_BASE_URL).toBe('http://localhost:8000')
    expect(c.OCR_API_TIMEOUT_MS).toBe(15000)
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
