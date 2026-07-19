import { describe, expect, test } from 'bun:test'
import { loadConfig, SettingsJsonSchema } from './schema'

function validJson() {
  return {
    transport: {
      httpProxy: '',
      httpsProxy: '',
      noProxy: 'localhost,127.0.0.1',
      telegramBotToken: 'tok',
      qqBotAppId: '',
      qqBotAppSecret: '',
      qqBotWsProxy: '',
      qqBotOpenIdDiscovery: false,
      whitelistUserIds: ['111', '222', '333'],
    },
    database: {
      host: '127.0.0.1',
      port: 5432,
      db: 'test_db',
      username: 'u',
      password: 'p',
    },
    memory: {
      embedding: {
        apiBaseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-x',
        model: 'BAAI/bge-m3',
        dimensions: 1024,
      },
      recallTopK: 10,
      summary: {
        apiBaseUrl: '',
        apiKey: '',
        model: '',
        requestedSummaryMessageLimit: 10,
        maxChars: 600,
      },
    },
    lifecycle: {
      agentIdleTimeoutMs: 300_000,
      agentTurnTimeoutMs: 60_000,
      serviceShutdownTimeoutMs: 15_000,
      sessionArchiveDays: 7,
    },
    session: {
      agentDescription: '',
      claudeExecutablePath: '',
      recentContextLimit: 10,
      recentContextMessageMaxChars: 1200,
    },
    aggregator: {
      debounceMs: 400,
      minEditIntervalMs: 1000,
      maxChunkChars: 4096,
    },
    media: {
      downloadDir: '.data/media',
      maxFileBytes: 10_485_760,
      maxTextChars: 20_000,
      parseTimeoutMs: 30_000,
      pdfMaxPages: 20,
      pdfRenderScale: 2,
    },
    ocr: {
      apiBaseUrl: '',
      apiTimeoutMs: 30_000,
    },
    envProbe: {
      timeoutMs: 1500,
    },
    ops: {
      workdir: null,
      commandTimeoutMs: 120_000,
      requireCleanWorktree: true,
      restartCommand: 'pm2',
      restartArgs: ['restart', 'ai-cli-hub'],
      restartDelayMs: 1500,
      restartNoticeFile: '.data/update-restart-notice.json',
    },
    logging: {
      level: 'info' as const,
    },
    debug: {
      agentSdkJson: false,
      messageFlow: false,
    },
  }
}

describe('loadConfig', () => {
  test('校验通过并套用默认值', () => {
    const c = loadConfig(validJson())
    expect(c.WHITELIST_USER_IDS).toEqual(['111', '222', '333'])
    expect(c.HTTP_HOST).toBe('127.0.0.1')
    expect(c.HTTP_PORT).toBe(8787)
    expect(c.HTTP_AUTH_TOKEN).toBe('')
    expect(c.TELEGRAM_BOT_TOKEN).toBe('tok')
    expect(c.QQBOT_APP_ID).toBe('')
    expect(c.QQBOT_APP_SECRET).toBe('')
    expect(c.QQBOT_OPENID_DISCOVERY).toBe(false)
    expect(c.DATABASE_URL).toBe('postgres://u:p@127.0.0.1:5432/test_db')
    expect(c.CLAUDE_EXECUTABLE_PATH).toBe('')
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

  test('agentDescription 从 JSON 读取', () => {
    const c = loadConfig({
      ...validJson(),
      session: { ...validJson().session, agentDescription: '负责远程管理个人 VPS 上的 AI CLI 会话。' },
    })
    expect(c.AGENT_DESCRIPTION).toBe('负责远程管理个人 VPS 上的 AI CLI 会话。')
  })

  test('数值型字段被正确保留', () => {
    const c = loadConfig({
      ...validJson(),
      memory: {
        ...validJson().memory,
        embedding: { ...validJson().memory.embedding, dimensions: 768 },
        recallTopK: 12,
        summary: { ...validJson().memory.summary, requestedSummaryMessageLimit: 9, maxChars: 800 },
      },
      lifecycle: {
        ...validJson().lifecycle,
        agentIdleTimeoutMs: 60000,
        agentTurnTimeoutMs: 45000,
        serviceShutdownTimeoutMs: 12000,
      },
      session: { ...validJson().session, recentContextLimit: 8, recentContextMessageMaxChars: 900 },
      aggregator: { ...validJson().aggregator, debounceMs: 300, minEditIntervalMs: 800, maxChunkChars: 3500 },
      envProbe: { timeoutMs: 1000 },
      ops: {
        ...validJson().ops,
        commandTimeoutMs: 90000,
        restartDelayMs: 2000,
      },
    })
    expect(c.EMBEDDING_DIMENSIONS).toBe(768)
    expect(c.MEMORY_RECALL_TOP_K).toBe(12)
    expect(c.MEMORY_REQUESTED_SUMMARY_MESSAGE_LIMIT).toBe(9)
    expect(c.MEMORY_SUMMARY_MAX_CHARS).toBe(800)
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

  test('Update 配置从 JSON 读取', () => {
    const c = loadConfig({
      ...validJson(),
      ops: {
        ...validJson().ops,
        workdir: '/srv/ai-cli-hub',
        requireCleanWorktree: false,
        restartCommand: 'systemctl',
        restartArgs: ['restart', 'ai-cli-hub'],
        restartNoticeFile: '/tmp/ai-cli-hub-restart.json',
      },
    })
    expect(c.UPDATE_WORKDIR).toBe('/srv/ai-cli-hub')
    expect(c.UPDATE_REQUIRE_CLEAN_WORKTREE).toBe(false)
    expect(c.UPDATE_RESTART_COMMAND).toBe('systemctl')
    expect(c.UPDATE_RESTART_ARGS).toEqual(['restart', 'ai-cli-hub'])
    expect(c.UPDATE_RESTART_NOTICE_FILE).toBe('/tmp/ai-cli-hub-restart.json')
  })

  test('Embedding API base URL 从 JSON 读取', () => {
    const c = loadConfig({
      ...validJson(),
      memory: {
        ...validJson().memory,
        embedding: { ...validJson().memory.embedding, apiBaseUrl: 'https://api.example.com/v1' },
      },
    })
    expect(c.EMBEDDING_API_BASE_URL).toBe('https://api.example.com/v1')
  })

  test('Memory summary API 配置从 JSON 读取', () => {
    const c = loadConfig({
      ...validJson(),
      memory: {
        ...validJson().memory,
        summary: {
          ...validJson().memory.summary,
          apiBaseUrl: 'https://llm.example.com/v1',
          apiKey: 'sk-summary',
          model: 'qwen-summary',
          maxChars: 800,
        },
      },
    })
    expect(c.MEMORY_SUMMARY_API_BASE_URL).toBe('https://llm.example.com/v1')
    expect(c.MEMORY_SUMMARY_API_KEY).toBe('sk-summary')
    expect(c.MEMORY_SUMMARY_MODEL).toBe('qwen-summary')
    expect(c.MEMORY_SUMMARY_MAX_CHARS).toBe(800)
  })

  test('媒体限制从 JSON 读取', () => {
    const c = loadConfig({
      ...validJson(),
      media: {
        ...validJson().media,
        downloadDir: 'D:/hub-media',
        maxFileBytes: 1024,
        maxTextChars: 2048,
        parseTimeoutMs: 5000,
        pdfMaxPages: 5,
        pdfRenderScale: 1.5,
      },
    })
    expect(c.MEDIA_DOWNLOAD_DIR).toBe('D:/hub-media')
    expect(c.MEDIA_MAX_FILE_BYTES).toBe(1024)
    expect(c.MEDIA_MAX_TEXT_CHARS).toBe(2048)
    expect(c.MEDIA_PARSE_TIMEOUT_MS).toBe(5000)
    expect(c.MEDIA_PDF_MAX_PAGES).toBe(5)
    expect(c.MEDIA_PDF_RENDER_SCALE).toBe(1.5)
  })

  test('OCR API 配置从 JSON 读取', () => {
    const c = loadConfig({
      ...validJson(),
      ocr: {
        ...validJson().ocr,
        apiBaseUrl: 'http://localhost:8000',
        apiTimeoutMs: 15000,
      },
    })
    expect(c.OCR_API_BASE_URL).toBe('http://localhost:8000')
    expect(c.OCR_API_TIMEOUT_MS).toBe(15000)
  })

  test('缺失必填项时 fail-fast 抛错', () => {
    expect(() => loadConfig({})).toThrow(/Invalid config/)
  })

  test('白名单为空数组时抛错（至少一个 id）', () => {
    const v = validJson()
    v.transport.whitelistUserIds = []
    expect(() => loadConfig(v)).toThrow(/Invalid config/)
  })

  test('embeddingApiKey 为空时抛错', () => {
    const v = validJson()
    v.memory.embedding.apiKey = ''
    expect(() => loadConfig(v)).toThrow(/Invalid config/)
  })

  test('QQ Bot App ID 和 Secret 必须同时配置，TG/QQ 白名单可混用', () => {
    const v = validJson()
    v.transport.whitelistUserIds = ['123456', 'QQ_OPENID']
    v.transport.qqBotAppId = 'app'
    v.transport.qqBotAppSecret = 'secret'
    const c = loadConfig(v)
    expect(c.WHITELIST_USER_IDS).toEqual(['123456', 'QQ_OPENID'])
    expect(() => loadConfig({ ...v, transport: { ...v.transport, qqBotAppId: 'app', qqBotAppSecret: '' } })).toThrow(
      /must be set together/,
    )
  })

  test('QQ OpenID 发现开关默认关闭，可显式启用', () => {
    expect(loadConfig(validJson()).QQBOT_OPENID_DISCOVERY).toBe(false)
    expect(
      loadConfig({ ...validJson(), transport: { ...validJson().transport, qqBotOpenIdDiscovery: true } })
        .QQBOT_OPENID_DISCOVERY,
    ).toBe(true)
  })

  test('非法 LOG_LEVEL 枚举时抛错', () => {
    expect(() => loadConfig({ ...validJson(), logging: { level: 'verbose' as never } })).toThrow(/Invalid config/)
  })

  test('调试 bool 字段可切换', () => {
    expect(
      loadConfig({ ...validJson(), debug: { ...validJson().debug, agentSdkJson: true } }).DEBUG_AGENT_SDK_JSON,
    ).toBe(true)
    expect(loadConfig({ ...validJson(), debug: { ...validJson().debug, messageFlow: true } }).DEBUG_MESSAGE_FLOW).toBe(
      true,
    )
    expect(loadConfig(validJson()).DEBUG_AGENT_SDK_JSON).toBe(false)
    expect(loadConfig(validJson()).DEBUG_MESSAGE_FLOW).toBe(false)
  })

  test('DATABASE_URL 正确拼装（含特殊字符 URL 编码）', () => {
    const v = validJson()
    v.database = { host: 'db.example.com', port: 15432, db: 'myhub', username: 'hub@admin', password: 'p@ss:word' }
    const c = loadConfig(v)
    expect(c.DATABASE_URL).toBe('postgres://hub%40admin:p%40ss%3Aword@db.example.com:15432/myhub')
  })

  test('代理变量写回 process.env', () => {
    // 先清理
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.NO_PROXY

    loadConfig({
      ...validJson(),
      transport: {
        ...validJson().transport,
        httpProxy: 'http://127.0.0.1:7897',
        httpsProxy: 'http://127.0.0.1:7897',
        noProxy: 'localhost',
      },
    })
    const env = process.env as Record<string, string | undefined>
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.NO_PROXY).toBe('localhost')
  })

  test('QQ WebSocket 代理只回退到 settings.json 代理配置', () => {
    const originalAllProxy = process.env.ALL_PROXY
    try {
      process.env.ALL_PROXY = 'http://ambient-proxy:7890'
      const configured = validJson()
      configured.transport.httpsProxy = 'http://settings-proxy:7897'
      expect(loadConfig(configured).QQBOT_WS_PROXY).toBe('http://settings-proxy:7897')

      const empty = validJson()
      expect(loadConfig(empty).QQBOT_WS_PROXY).toBe('')
    } finally {
      if (originalAllProxy === undefined) delete process.env.ALL_PROXY
      else process.env.ALL_PROXY = originalAllProxy
    }
  })
})

describe('SettingsJsonSchema', () => {
  test('合法 JSON 通过校验', () => {
    const parsed = SettingsJsonSchema.safeParse(validJson())
    expect(parsed.success).toBe(true)
  })
})
