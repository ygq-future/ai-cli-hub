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
    expect(c.EMBEDDING_API_BASE_URL).toBe('https://api.openai.com/v1')
    expect(c.EMBEDDING_MODEL).toBe('BAAI/bge-m3')
    expect(c.EMBEDDING_DIMENSIONS).toBe(1024)
    expect(c.MEMORY_RECALL_TOP_K).toBe(10)
    expect(c.MEMORY_SUMMARY_API_BASE_URL).toBe('')
    expect(c.MEMORY_SUMMARY_API_KEY).toBe('')
    expect(c.MEMORY_SUMMARY_MODEL).toBe('')
    expect(c.MEMORY_REQUESTED_SUMMARY_MESSAGE_LIMIT).toBe(10)
    expect(c.MEMORY_SUMMARY_MAX_CHARS).toBe(600)
    expect(c.AGENT_IDLE_TIMEOUT_MS).toBe(300_000)
    expect(c.AGENT_TURN_TIMEOUT_MS).toBe(60_000)
    expect(c.SERVICE_SHUTDOWN_TIMEOUT_MS).toBe(15_000)
    expect(c.SESSION_ARCHIVE_DAYS).toBe(7)
    expect(c.AGENT_DESCRIPTION).toBe('')
    expect(c.RECENT_CONTEXT_LIMIT).toBe(10)
    expect(c.RECENT_CONTEXT_MESSAGE_MAX_CHARS).toBe(1200)
    expect(c.AGGREGATOR_DEBOUNCE_MS).toBe(400)
    expect(c.AGGREGATOR_MIN_EDIT_INTERVAL_MS).toBe(1000)
    expect(c.AGGREGATOR_MAX_CHUNK_CHARS).toBe(4096)
    expect(c.MEDIA_DOWNLOAD_DIR).toBe('.data/media')
    expect(c.MEDIA_MAX_FILE_BYTES).toBe(10 * 1024 * 1024)
    expect(c.MEDIA_MAX_TEXT_CHARS).toBe(20_000)
    expect(c.MEDIA_PARSE_TIMEOUT_MS).toBe(30_000)
    expect(c.OCR_API_BASE_URL).toBe('')
    expect(c.OCR_API_TIMEOUT_MS).toBe(30_000)
    expect(c.ENV_PROBE_TIMEOUT_MS).toBe(1500)
    expect(c.UPDATE_WORKDIR).toBe(process.cwd())
    expect(c.UPDATE_COMMAND_TIMEOUT_MS).toBe(120_000)
    expect(c.UPDATE_REQUIRE_CLEAN_WORKTREE).toBe(true)
    expect(c.UPDATE_RESTART_COMMAND).toBe('pm2')
    expect(c.UPDATE_RESTART_ARGS).toEqual(['restart', 'ai-cli-hub'])
    expect(c.UPDATE_RESTART_DELAY_MS).toBe(1500)
    expect(c.UPDATE_RESTART_NOTICE_FILE).toBe('.data/update-restart-notice.json')
    expect(c.LOG_LEVEL).toBe('info')
    expect(c.DEBUG_AGENT_SDK_JSON).toBe(false)
    expect(c.DEBUG_MESSAGE_FLOW).toBe(false)
  })

  test('AGENT_DESCRIPTION 从 env 读取', () => {
    const c = loadConfig({ ...VALID, AGENT_DESCRIPTION: '负责远程管理个人 VPS 上的 AI CLI 会话。' })
    expect(c.AGENT_DESCRIPTION).toBe('负责远程管理个人 VPS 上的 AI CLI 会话。')
  })

  test('数值型 env 字符串被强制转换', () => {
    const c = loadConfig({
      ...VALID,
      EMBEDDING_DIMENSIONS: '768',
      MEMORY_RECALL_TOP_K: '12',
      MEMORY_REQUESTED_SUMMARY_MESSAGE_LIMIT: '9',
      AGENT_IDLE_TIMEOUT_MS: '60000',
      AGENT_TURN_TIMEOUT_MS: '45000',
      SERVICE_SHUTDOWN_TIMEOUT_MS: '12000',
      RECENT_CONTEXT_LIMIT: '8',
      RECENT_CONTEXT_MESSAGE_MAX_CHARS: '900',
      AGGREGATOR_DEBOUNCE_MS: '300',
      AGGREGATOR_MIN_EDIT_INTERVAL_MS: '800',
      AGGREGATOR_MAX_CHUNK_CHARS: '3500',
      ENV_PROBE_TIMEOUT_MS: '1000',
      UPDATE_COMMAND_TIMEOUT_MS: '90000',
      UPDATE_RESTART_DELAY_MS: '2000',
    })
    expect(c.EMBEDDING_DIMENSIONS).toBe(768)
    expect(c.MEMORY_RECALL_TOP_K).toBe(12)
    expect(c.MEMORY_REQUESTED_SUMMARY_MESSAGE_LIMIT).toBe(9)
    expect(c.AGENT_IDLE_TIMEOUT_MS).toBe(60000)
    expect(c.AGENT_TURN_TIMEOUT_MS).toBe(45000)
    expect(c.SERVICE_SHUTDOWN_TIMEOUT_MS).toBe(12000)
    expect(c.RECENT_CONTEXT_LIMIT).toBe(8)
    expect(c.RECENT_CONTEXT_MESSAGE_MAX_CHARS).toBe(900)
    expect(c.AGGREGATOR_DEBOUNCE_MS).toBe(300)
    expect(c.AGGREGATOR_MIN_EDIT_INTERVAL_MS).toBe(800)
    expect(c.AGGREGATOR_MAX_CHUNK_CHARS).toBe(3500)
    expect(c.ENV_PROBE_TIMEOUT_MS).toBe(1000)
    expect(c.UPDATE_COMMAND_TIMEOUT_MS).toBe(90000)
    expect(c.UPDATE_RESTART_DELAY_MS).toBe(2000)
  })

  test('Update 配置从 env 读取', () => {
    const c = loadConfig({
      ...VALID,
      UPDATE_WORKDIR: '/srv/ai-cli-hub',
      UPDATE_REQUIRE_CLEAN_WORKTREE: 'false',
      UPDATE_RESTART_COMMAND: 'systemctl',
      UPDATE_RESTART_ARGS: 'restart,ai-cli-hub',
      UPDATE_RESTART_NOTICE_FILE: '/tmp/ai-cli-hub-restart.json',
    })
    expect(c.UPDATE_WORKDIR).toBe('/srv/ai-cli-hub')
    expect(c.UPDATE_REQUIRE_CLEAN_WORKTREE).toBe(false)
    expect(c.UPDATE_RESTART_COMMAND).toBe('systemctl')
    expect(c.UPDATE_RESTART_ARGS).toEqual(['restart', 'ai-cli-hub'])
    expect(c.UPDATE_RESTART_NOTICE_FILE).toBe('/tmp/ai-cli-hub-restart.json')
  })

  test('Embedding API base URL 从 env 读取', () => {
    const c = loadConfig({ ...VALID, EMBEDDING_API_BASE_URL: 'https://api.example.com/v1' })
    expect(c.EMBEDDING_API_BASE_URL).toBe('https://api.example.com/v1')
  })

  test('Memory summary API 配置从 env 读取', () => {
    const c = loadConfig({
      ...VALID,
      MEMORY_SUMMARY_API_BASE_URL: 'https://llm.example.com/v1',
      MEMORY_SUMMARY_API_KEY: 'sk-summary',
      MEMORY_SUMMARY_MODEL: 'qwen-summary',
      MEMORY_SUMMARY_MAX_CHARS: '800',
    })
    expect(c.MEMORY_SUMMARY_API_BASE_URL).toBe('https://llm.example.com/v1')
    expect(c.MEMORY_SUMMARY_API_KEY).toBe('sk-summary')
    expect(c.MEMORY_SUMMARY_MODEL).toBe('qwen-summary')
    expect(c.MEMORY_SUMMARY_MAX_CHARS).toBe(800)
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
    expect(loadConfig({ ...VALID, DEBUG_MESSAGE_FLOW: 'yes' }).DEBUG_MESSAGE_FLOW).toBe(true)
    expect(loadConfig({ ...VALID, DEBUG_MESSAGE_FLOW: 'no' }).DEBUG_MESSAGE_FLOW).toBe(false)
  })

  test('非法调试布尔 env 时抛错', () => {
    expect(() => loadConfig({ ...VALID, DEBUG_AGENT_SDK_JSON: 'maybe' })).toThrow(/Invalid config/)
  })
})
