import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../../config'
import { createEventBus } from '../../event'
import type { QQBotClient, QQGatewayEvent, QQKeyboard, QQStreamRequest } from './qq-bot-client'
import { createQQTransport } from './qq-transport'

const CID = 'conv-qq' as never

function fakeConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    TELEGRAM_BOT_TOKEN: '',
    QQBOT_APP_ID: 'app-id',
    QQBOT_APP_SECRET: 'app-secret',
    WHITELIST_USER_IDS: 'qq-openid,tg-id',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    EMBEDDING_API_KEY: 'sk-test',
    DEFAULT_CWD: '/workspace',
    ...extra,
  })
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
      config: fakeConfig({ QQBOT_OPENID_DISCOVERY: 'true' }),
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
