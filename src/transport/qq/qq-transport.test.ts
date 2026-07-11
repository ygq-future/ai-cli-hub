import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../../config'
import { createEventBus } from '../../event'
import type { QQBotClient, QQGatewayEvent, QQKeyboard, QQStreamRequest } from './qq-bot-client'
import type { MediaPreprocessInput, MediaPreprocessResult, MediaPreprocessor } from '../../shared'
import { createQQTransport } from './qq-transport'

const CID = 'conv-qq' as never

function fakeConfig(extra?: Partial<ReturnType<typeof loadConfig>>) {
  const base = loadConfig({
    transport: {
      httpProxy: '',
      httpsProxy: '',
      noProxy: 'localhost,127.0.0.1',
      telegramBotToken: '',
      qqBotAppId: 'app-id',
      qqBotAppSecret: 'app-secret',
      qqBotWsProxy: '',
      qqBotOpenIdDiscovery: false,
      whitelistUserIds: ['qq-openid', 'tg-id'],
    },
    database: { host: '127.0.0.1', port: 5432, db: 'ai_cli_hub', username: 'u', password: 'p' },
    memory: {
      embedding: { apiBaseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'BAAI/bge-m3', dimensions: 1024 },
      recallTopK: 10,
      summary: { apiBaseUrl: '', apiKey: '', model: '', requestedSummaryMessageLimit: 10, maxChars: 600 },
    },
    lifecycle: {
      agentIdleTimeoutMs: 300_000,
      agentTurnTimeoutMs: 60_000,
      serviceShutdownTimeoutMs: 15_000,
      sessionArchiveDays: 7,
    },
    session: {
      defaultCwd: '/workspace',
      agentDescription: '',
      recentContextLimit: 10,
      recentContextMessageMaxChars: 1200,
    },
    aggregator: { debounceMs: 400, minEditIntervalMs: 1000, maxChunkChars: 4096 },
    media: { downloadDir: '.data/media', maxFileBytes: 10_485_760, maxTextChars: 20_000, parseTimeoutMs: 30_000 },
    ocr: { apiBaseUrl: '', apiTimeoutMs: 30_000 },
    envProbe: { timeoutMs: 1500 },
    ops: {
      workdir: null,
      commandTimeoutMs: 120_000,
      requireCleanWorktree: true,
      restartCommand: 'pm2',
      restartArgs: ['restart', 'ai-cli-hub'],
      restartDelayMs: 1500,
      restartNoticeFile: '.data/update-restart-notice.json',
    },
    logging: { level: 'info' },
    debug: { agentSdkJson: false, messageFlow: false },
  })
  if (extra) return { ...base, ...extra }
  return base
}

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function createFakeClient() {
  let handler: ((event: QQGatewayEvent) => void) | undefined
  let nextId = 0
  const messages: Array<{ openId: string; content: string; messageId?: string; keyboard?: QQKeyboard }> = []
  const streams: Array<{ openId: string; request: QQStreamRequest }> = []
  const client: QQBotClient = {
    async start(nextHandler, nextStatus) {
      handler = nextHandler
      nextStatus?.({ state: 'connecting', detail: 'fake gateway' })
      nextStatus?.({ state: 'ready', detail: 'fake ready' })
    },
    async stop() {},
    async sendC2CMessage(openId, content, messageId, keyboard) {
      messages.push({ openId, content, messageId, keyboard })
      return { id: `message-${++nextId}` }
    },
    async sendC2CStreamMessage(openId, request) {
      streams.push({ openId, request })
      return { id: request.streamMessageId ?? `stream-${++nextId}` }
    },
    async ackInteraction(_interactionId) {
      // no-op in fake
    },
  }
  return {
    client,
    messages,
    streams,
    emit(event: QQGatewayEvent) {
      handler?.(event)
    },
  }
}

function c2c(userId = 'qq-openid', content = 'hello'): QQGatewayEvent {
  return {
    type: 'C2C_MESSAGE_CREATE',
    data: { id: 'message-in-1', event_id: 'event-1', content, author: { user_openid: userId } },
  }
}

describe('QQTransport 官方 C2C 入站', () => {
  test('白名单用户的 C2C 文本发出统一 MessageReceived', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const transport = createQQTransport({ bus, config: fakeConfig(), client: fake.client })
    await transport.start()
    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))

    fake.emit(c2c())
    await tick()

    expect(received).toEqual([
      {
        userId: 'qq-openid',
        platform: 'qq',
        cli: 'claude',
        cwd: '/workspace',
        text: 'hello',
        ref: { platform: 'qq', chatId: 'qq-openid', nativeId: 'message-in-1' },
      },
    ])
  })

  test('启动状态会通过 EventBus 输出，便于确认 QQ Gateway 已 ready', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const statuses: Array<{ state: string; detail?: string }> = []
    bus.on('TransportStatusChanged', p => {
      if (p.platform === 'qq') statuses.push({ state: p.state, detail: p.detail })
    })

    await createQQTransport({ bus, config: fakeConfig(), client: fake.client }).start()

    expect(statuses).toEqual([
      { state: 'starting', detail: '正在启动腾讯官方 QQ Bot Transport' },
      { state: 'connecting', detail: 'fake gateway' },
      { state: 'ready', detail: 'fake ready' },
    ])
  })

  test('非白名单 QQ OpenID 静默丢弃', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const transport = createQQTransport({ bus, config: fakeConfig(), client: fake.client })
    await transport.start()
    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))

    fake.emit(c2c('not-allowed'))
    await tick()

    expect(received).toEqual([])
    expect(fake.messages).toEqual([])
  })

  test('OpenID 发现开关只记录一次本机日志，不回复也不进入 Core', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const transport = createQQTransport({
      bus,
      config: fakeConfig({ QQBOT_OPENID_DISCOVERY: true }),
      client: fake.client,
    })
    await transport.start()
    const errors: unknown[] = []
    const received: unknown[] = []
    bus.on('ErrorOccurred', p => errors.push(p))
    bus.on('MessageReceived', p => received.push(p))

    fake.emit(c2c('candidate-openid'))
    fake.emit(c2c('candidate-openid'))
    await tick()

    expect(errors).toEqual([
      {
        scope: 'qq:openid-discovery',
        message: expect.stringContaining('candidate-openid'),
      },
    ])
    expect(received).toEqual([])
    expect(fake.messages).toEqual([])
  })

  test('/lang 只更新 QQ 用户语言并回复确认', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const transport = createQQTransport({ bus, config: fakeConfig(), client: fake.client })
    await transport.start()

    fake.emit(c2c('qq-openid', '/lang en'))
    await tick()

    expect(transport.getUserLanguage('qq-openid')).toBe('en')
    expect(fake.messages[0]?.content).toBe('Language switched to English.')
  })
})

describe('QQTransport 出站流式与审批', () => {
  test('没有当前入站上下文时仍可主动发送（重启通知）', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const transport = createQQTransport({ bus, config: fakeConfig(), client: fake.client })
    await transport.start()

    await transport.sendMessage('qq-openid', '✅ 服务已重启完成')

    expect(fake.messages).toEqual([
      { openId: 'qq-openid', content: '✅ 服务已重启完成', messageId: undefined, keyboard: undefined },
    ])
  })

  test('QQ 会话映射后用官方 stream_messages 连续刷新并 final 定稿', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const transport = createQQTransport({ bus, config: fakeConfig(), client: fake.client })
    await transport.start()
    fake.emit(c2c())
    bus.emit('SessionCreated', {
      conversationId: CID,
      platform: 'qq',
      userId: 'qq-openid',
      cli: 'claude',
      cwd: '/workspace',
    })

    bus.emit('MessageGenerated', { conversationId: CID, content: 'Hel', final: false })
    await tick()
    bus.emit('MessageGenerated', { conversationId: CID, content: 'Hello', final: false })
    await tick()
    bus.emit('MessageGenerated', { conversationId: CID, content: 'Hello', final: true })
    await tick()

    expect(fake.streams).toHaveLength(3)
    expect(fake.streams.map(item => item.request.content)).toEqual(['Hel', 'Hello', 'Hello'])
    expect(fake.streams.map(item => item.request.final)).toEqual([false, false, true])
    expect(fake.streams[1]?.request.streamMessageId).toBe('stream-1')
    expect(fake.streams[2]?.request.index).toBe(2)
  })

  test('审批卡使用 QQ 官方回调键盘；交互事件只决议一次', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const transport = createQQTransport({ bus, config: fakeConfig(), client: fake.client })
    await transport.start()
    fake.emit(c2c())
    bus.emit('SessionCreated', {
      conversationId: CID,
      platform: 'qq',
      userId: 'qq-openid',
      cli: 'claude',
      cwd: '/workspace',
    })
    const approved: unknown[] = []
    bus.on('ApprovalApproved', p => approved.push(p))

    bus.emit('ApprovalRequested', {
      conversationId: CID,
      approvalId: 'approval-1',
      command: 'Write',
      detail: '{"path":"a.txt"}',
    })
    await tick()

    const keyboard = fake.messages[0]?.keyboard
    expect(keyboard?.content.rows[0]?.buttons.map(button => button.action.data)).toEqual([
      'ai-cli-hub:approve:approval-1',
      'ai-cli-hub:reject:approval-1',
    ])
    fake.emit({
      type: 'INTERACTION_CREATE',
      data: { user_openid: 'qq-openid', data: { resolved: { button_data: 'ai-cli-hub:approve:approval-1' } } },
    })
    await tick()
    fake.emit({
      type: 'INTERACTION_CREATE',
      data: { user_openid: 'qq-openid', data: { resolved: { button_data: 'ai-cli-hub:approve:approval-1' } } },
    })
    await tick()

    expect(approved).toEqual([{ conversationId: CID, approvalId: 'approval-1', operator: 'qq-openid' }])
    expect(fake.messages.some(message => message.content.includes('已批准'))).toBe(true)
  })
})

describe('QQTransport 媒体入站', () => {
  function fakeMediaPreprocessor(): MediaPreprocessor & { calls: MediaPreprocessInput[] } {
    const calls: MediaPreprocessInput[] = []
    return {
      calls,
      async preprocess(input: MediaPreprocessInput): Promise<MediaPreprocessResult> {
        calls.push(input)
        const lines: string[] = [input.text || '[media message]']
        if (input.attachments?.length) {
          lines.push(`[attachments: ${input.attachments.map(a => a.kind).join(',')}]`)
        }
        return { text: lines.join('\n'), warnings: [] }
      },
    }
  }

  function c2cWithAttachments(
    userId = 'qq-openid',
    content = '',
    attachments: Array<Record<string, unknown>> = [],
  ): QQGatewayEvent {
    return {
      type: 'C2C_MESSAGE_CREATE',
      data: {
        id: 'message-att-1',
        event_id: 'event-att-1',
        content,
        author: { user_openid: userId },
        attachments,
      },
    }
  }

  test('图片附件下载后走 mediaPreprocessor（kind=photo）', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const preprocessor = fakeMediaPreprocessor()
    const downloads: Array<{ url: string }> = []
    const transport = createQQTransport({
      bus,
      config: fakeConfig(),
      client: fake.client,
      mediaPreprocessor: preprocessor,
      downloadQQFile: async (url, _opts) => {
        downloads.push({ url })
        return `/media/qq-${Date.now()}.jpg`
      },
    })
    await transport.start()
    const received: Array<{ text: string }> = []
    bus.on('MessageReceived', p => received.push(p))

    fake.emit(
      c2cWithAttachments('qq-openid', '看看这张图', [
        { content_type: 'image/jpeg', url: 'https://qq.example.com/img.jpg', filename: 'photo.jpg', size: 12345 },
      ]),
    )
    await tick()

    expect(downloads.length).toBe(1)
    expect(preprocessor.calls.length).toBe(1)
    expect(preprocessor.calls[0]?.attachments).toEqual([
      expect.objectContaining({ kind: 'photo', fileName: 'photo.jpg', mimeType: 'image/jpeg', fileSize: 12345 }),
    ])
    expect(received.length).toBe(1)
    expect(received[0]?.text).toContain('[attachments: photo]')
  })

  test('GIF 表情包按 image/gif → kind=photo 归类', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const preprocessor = fakeMediaPreprocessor()
    const transport = createQQTransport({
      bus,
      config: fakeConfig(),
      client: fake.client,
      mediaPreprocessor: preprocessor,
      downloadQQFile: async () => `/media/qq-sticker.gif`,
    })
    await transport.start()

    fake.emit(
      c2cWithAttachments('qq-openid', '', [
        { content_type: 'image/gif', url: 'https://qq.example.com/sticker.gif', filename: 'sticker.gif', size: 9999 },
      ]),
    )
    await tick()

    expect(preprocessor.calls[0]?.attachments).toEqual([
      expect.objectContaining({ kind: 'photo', mimeType: 'image/gif' }),
    ])
  })

  test('普通文件按 file → kind=document 归类', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const preprocessor = fakeMediaPreprocessor()
    const transport = createQQTransport({
      bus,
      config: fakeConfig(),
      client: fake.client,
      mediaPreprocessor: preprocessor,
      downloadQQFile: async () => `/media/qq-doc.pdf`,
    })
    await transport.start()

    fake.emit(
      c2cWithAttachments('qq-openid', '帮我看看这个文档', [
        { content_type: 'file', url: 'https://qq.example.com/doc.pdf', filename: 'report.pdf', size: 50000 },
      ]),
    )
    await tick()

    expect(preprocessor.calls[0]?.attachments).toEqual([
      expect.objectContaining({ kind: 'document', fileName: 'report.pdf', mimeType: 'file' }),
    ])
  })

  test('语音消息注入 ASR 文本并归类为 voice', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const preprocessor = fakeMediaPreprocessor()
    const transport = createQQTransport({
      bus,
      config: fakeConfig(),
      client: fake.client,
      mediaPreprocessor: preprocessor,
      downloadQQFile: async () => `/media/qq-voice.wav`,
    })
    await transport.start()

    fake.emit(
      c2cWithAttachments('qq-openid', '', [
        {
          content_type: 'voice',
          url: 'https://qq.example.com/voice.wav',
          filename: 'voice.wav',
          size: 8000,
          asr_refer_text: '你好请问在吗',
        },
      ]),
    )
    await tick()

    expect(preprocessor.calls[0]?.text).toContain('[Voice ASR: 你好请问在吗]')
    expect(preprocessor.calls[0]?.attachments).toEqual([expect.objectContaining({ kind: 'voice' })])
  })

  test('无附件纯文本仍走 mediaPreprocessor（emoji 归一化）', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const preprocessor = fakeMediaPreprocessor()
    const transport = createQQTransport({
      bus,
      config: fakeConfig(),
      client: fake.client,
      mediaPreprocessor: preprocessor,
    })
    await transport.start()
    const received: Array<{ text: string }> = []
    bus.on('MessageReceived', p => received.push(p))

    fake.emit(c2c('qq-openid', 'hello 😊'))
    await tick()

    expect(preprocessor.calls.length).toBe(1)
    expect(preprocessor.calls[0]?.text).toBe('hello 😊')
    expect(received[0]?.text).toContain('hello')
  })

  test('attachments 没有 url 时跳过下载（空附件列表）', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const preprocessor = fakeMediaPreprocessor()
    const transport = createQQTransport({
      bus,
      config: fakeConfig(),
      client: fake.client,
      mediaPreprocessor: preprocessor,
    })
    await transport.start()

    fake.emit(c2cWithAttachments('qq-openid', 'hi', [{ content_type: 'image/png', filename: 'no-url.png', size: 100 }]))
    await tick()

    // 没有 url → 不下载 → 附件列表为空
    expect(preprocessor.calls[0]?.attachments?.length).toBe(0)
  })

  test('媒体预处理失败时发送错误提示', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const transport = createQQTransport({
      bus,
      config: fakeConfig(),
      client: fake.client,
      mediaPreprocessor: {
        async preprocess() {
          throw new Error('OCR service unavailable')
        },
      },
      downloadQQFile: async () => `/media/qq-img.jpg`,
    })
    await transport.start()

    fake.emit(
      c2cWithAttachments('qq-openid', '', [
        { content_type: 'image/jpeg', url: 'https://qq.example.com/img.jpg', filename: 'img.jpg', size: 1234 },
      ]),
    )
    await tick()

    expect(fake.messages.some(m => m.content.includes('OCR service unavailable'))).toBe(true)
  })

  test('文件超过 MEDIA_MAX_FILE_BYTES 不下载并报错', async () => {
    const bus = createEventBus()
    const fake = createFakeClient()
    const transport = createQQTransport({
      bus,
      config: fakeConfig({ MEDIA_MAX_FILE_BYTES: 1000 }),
      client: fake.client,
      mediaPreprocessor: fakeMediaPreprocessor(),
      downloadQQFile: async () => `/media/should-not-download.jpg`,
    })
    await transport.start()

    fake.emit(
      c2cWithAttachments('qq-openid', '', [
        { content_type: 'image/jpeg', url: 'https://qq.example.com/large.jpg', filename: 'large.jpg', size: 50000 },
      ]),
    )
    await tick()

    expect(fake.messages.some(m => m.content.includes('文件过大'))).toBe(true)
  })
})
