import { describe, expect, test } from 'bun:test'
import { createEventBus } from '../../event'
import { createTelegramTransport, type TelegramBotLike } from './telegram-transport'
import type { AppConfig } from '../../config'
import type { ConversationId } from '../../shared'

const CID = 'conv-1' as ConversationId
const tick = () => new Promise(r => setTimeout(r, 0))

function fakeConfig(): AppConfig {
  return {
    TELEGRAM_BOT_TOKEN: 'x',
    WHITELIST_USER_IDS: ['42'],
    DEFAULT_CWD: '/w',
    DATABASE_URL: 'postgres://x',
    EMBEDDING_API_KEY: 'k',
    EMBEDDING_MODEL: 'text-embedding-3-small',
    MEMORY_RECALL_TOP_K: 6,
    PTY_IDLE_TIMEOUT_MS: 300000,
    SESSION_ARCHIVE_DAYS: 7,
    LOG_LEVEL: 'info',
  } as AppConfig
}

interface Handlers {
  start?: (ctx: unknown) => unknown
  help?: (ctx: unknown) => unknown
  text?: (ctx: unknown) => unknown
  action?: (ctx: unknown) => unknown
}

function createMockBot(opts?: { failOnParseMode?: boolean }) {
  const handlers: Handlers = {}
  const sent: Array<{ chatId: string | number; text: string; extra?: unknown }> = []
  const edited: Array<{ chatId: string | number; messageId: number; text: string }> = []
  let seq = 100
  const bot: TelegramBotLike = {
    telegram: {
      async sendMessage(chatId, text, extra) {
        // 模拟 Telegram：带 parse_mode 时对某些字符抛 400（触发降级路径）
        if (opts?.failOnParseMode && (extra as { parse_mode?: string } | undefined)?.parse_mode) {
          throw new Error("400: Bad Request: can't parse entities: Character '+' is reserved")
        }
        sent.push({ chatId, text, extra })
        return { message_id: seq++ }
      },
      async editMessageText(chatId, messageId, _inline, text) {
        edited.push({ chatId, messageId, text })
        return true
      },
      async deleteMessage() {
        return true
      },
    },
    start(h) {
      handlers.start = h as Handlers['start']
    },
    help(h) {
      handlers.help = h as Handlers['help']
    },
    on(_f, h) {
      handlers.text = h as Handlers['text']
    },
    action(_re, h) {
      handlers.action = h as Handlers['action']
    },
    async launch() {},
    stop() {},
  }
  return { bot, handlers, sent, edited }
}

describe('TelegramTransport 入站', () => {
  test('白名单文本 → emit MessageReceived（不含 conversationId，D13）', () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hello', message_id: 5 } })

    expect(received).toEqual([
      {
        userId: '42',
        platform: 'telegram',
        cli: 'claude',
        cwd: '/w',
        text: 'hello',
        ref: { platform: 'telegram', chatId: '1000', nativeId: '5' },
      },
    ])
  })

  test('非白名单 → 静默丢弃，不 emit', () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))

    mock.handlers.text!({ from: { id: 999 }, chat: { id: 999 }, message: { text: 'hi', message_id: 1 } })

    expect(received.length).toBe(0)
  })

  test('/start（白名单）回复欢迎，不 emit MessageReceived', () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))
    const replies: string[] = []

    mock.handlers.start!({ from: { id: 42 }, chat: { id: 42 }, reply: async (t: string) => replies.push(t) })

    expect(replies.length).toBe(1)
    expect(replies[0]).toContain('AI CLI Hub')
    expect(received.length).toBe(0)
  })

  test('未知斜杠命令 → 提示，不 emit', () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))
    const replies: string[] = []

    mock.handlers.text!({
      from: { id: 42 },
      chat: { id: 42 },
      message: { text: '/status', message_id: 1 },
      reply: async (t: string) => replies.push(t),
    })

    expect(received.length).toBe(0)
    expect(replies.length).toBe(1)
  })
})

describe('TelegramTransport 出站流式（D12 累计全文）', () => {
  test('final=false 首发 sendMessage / 续发 editMessage；final=true 定稿', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    // 入站建立 userChat，SessionCreated 建立 convChat
    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hi', message_id: 1 } })
    bus.emit('SessionCreated', { conversationId: CID, platform: 'telegram', userId: '42', cli: 'claude', cwd: '/w' })

    bus.emit('MessageGenerated', { conversationId: CID, content: 'Hel', final: false })
    await tick()
    expect(mock.sent.length).toBe(1)
    expect(mock.sent[0]!.text.trim()).toBe('Hel')
    expect(mock.sent[0]!.chatId).toBe('1000')
    // 出站对话消息带 MarkdownV2 渲染（telegramify-markdown）
    expect((mock.sent[0]!.extra as { parse_mode?: string }).parse_mode).toBe('MarkdownV2')

    bus.emit('MessageGenerated', { conversationId: CID, content: 'Hello', final: false })
    await tick()
    expect(mock.edited.length).toBe(1)
    expect(mock.edited[0]!.text.trim()).toBe('Hello')
    expect(mock.edited[0]!.messageId).toBe(100)

    // final 内容与草稿一致 → 不重复 edit，仅清草稿（dedup 按原始 content）
    bus.emit('MessageGenerated', { conversationId: CID, content: 'Hello', final: true })
    await tick()
    expect(mock.edited.length).toBe(1)

    // 下一轮 final=false 重新 sendMessage（新草稿）
    bus.emit('MessageGenerated', { conversationId: CID, content: 'Next', final: false })
    await tick()
    expect(mock.sent.length).toBe(2)
  })

  test('GitHub 风格 markdown → Telegram MarkdownV2（**粗** → *粗*、## 标题 → 粗体）', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hi', message_id: 1 } })
    bus.emit('SessionCreated', { conversationId: CID, platform: 'telegram', userId: '42', cli: 'claude', cwd: '/w' })

    bus.emit('MessageGenerated', { conversationId: CID, content: '## 标题\n**粗体** 文本', final: true })
    await tick()

    expect(mock.sent.length).toBe(1)
    const out = mock.sent[0]!.text
    expect(out).toContain('*粗体*') // 双星号折叠为单星号（MarkdownV2 粗体）
    expect(out).not.toContain('**粗体**') // 不再残留 GFM 双星号
    expect(out).not.toContain('##') // 标题转为粗体，井号消失
    expect((mock.sent[0]!.extra as { parse_mode?: string }).parse_mode).toBe('MarkdownV2')
  })

  test("MarkdownV2 解析失败（400 can't parse entities）→ 降级纯文本重发，消息不丢", async () => {
    const bus = createEventBus()
    const mock = createMockBot({ failOnParseMode: true }) // 带 parse_mode 的发送抛 400
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const errors: unknown[] = []
    bus.on('ErrorOccurred', p => errors.push(p))

    // 入站建立 userChat，SessionCreated 建立 convChat
    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hi', message_id: 1 } })
    bus.emit('SessionCreated', { conversationId: CID, platform: 'telegram', userId: '42', cli: 'claude', cwd: '/w' })

    bus.emit('MessageGenerated', { conversationId: CID, content: 'a + b 与 **粗**', final: true })
    await tick()

    // 首次带 parse_mode 抛错被捕获 → 降级重发纯文本原文成功
    expect(mock.sent.length).toBe(1)
    expect(mock.sent[0]!.text).toBe('a + b 与 **粗**') // 纯文本原文（未转义）
    expect((mock.sent[0]!.extra as { parse_mode?: string } | undefined)?.parse_mode).toBeUndefined()
    // 降级成功 → 不冒泡 ErrorOccurred
    expect(errors.length).toBe(0)
  })

  test('无 convChat 映射 → 跳过（不发送）', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    bus.emit('MessageGenerated', { conversationId: CID, content: 'orphan', final: false })
    await tick()
    expect(mock.sent.length).toBe(0)
  })
})

describe('TelegramTransport 审批', () => {
  test('ApprovalRequested → 审批卡（内联按钮）；回调 → emit + 幂等', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hi', message_id: 1 } })
    bus.emit('SessionCreated', { conversationId: CID, platform: 'telegram', userId: '42', cli: 'claude', cwd: '/w' })

    bus.emit('ApprovalRequested', { conversationId: CID, approvalId: 'ap1', command: 'Bash', detail: '{"cmd":"ls"}' })
    await tick()

    expect(mock.sent.length).toBe(1)
    const extra = mock.sent[0]!.extra as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
    const buttons = extra.reply_markup.inline_keyboard[0]!.map(b => b.callback_data)
    expect(buttons).toEqual(['approve:ap1', 'reject:ap1'])

    const approved: unknown[] = []
    bus.on('ApprovalApproved', p => approved.push(p))

    const cbCtx = {
      from: { id: 42 },
      match: ['approve:ap1', 'approve', 'ap1'] as unknown as RegExpExecArray,
      answerCbQuery: async () => {},
    }
    mock.handlers.action!(cbCtx)
    await tick()

    expect(approved).toEqual([{ conversationId: CID, approvalId: 'ap1', operator: '42' }])
    // 卡片改写为终态
    expect(mock.edited.some(e => e.text.includes('已批准'))).toBe(true)

    // 幂等：重复点击不再 emit
    mock.handlers.action!(cbCtx)
    await tick()
    expect(approved.length).toBe(1)
  })

  test('Reject 回调 → emit ApprovalRejected', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hi', message_id: 1 } })
    bus.emit('SessionCreated', { conversationId: CID, platform: 'telegram', userId: '42', cli: 'claude', cwd: '/w' })
    bus.emit('ApprovalRequested', { conversationId: CID, approvalId: 'ap2', command: 'Write', detail: '{}' })
    await tick()

    const rejected: unknown[] = []
    bus.on('ApprovalRejected', p => rejected.push(p))

    mock.handlers.action!({
      from: { id: 42 },
      match: ['reject:ap2', 'reject', 'ap2'] as unknown as RegExpExecArray,
      answerCbQuery: async () => {},
    })
    await tick()

    expect(rejected).toEqual([{ conversationId: CID, approvalId: 'ap2', operator: '42' }])
  })

  test('审批卡 MarkdownV2 解析失败 → 降级纯文本，保留按钮，授权流不中断', async () => {
    const bus = createEventBus()
    const mock = createMockBot({ failOnParseMode: true })
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const errors: unknown[] = []
    bus.on('ErrorOccurred', p => errors.push(p))

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hi', message_id: 1 } })
    bus.emit('SessionCreated', { conversationId: CID, platform: 'telegram', userId: '42', cli: 'claude', cwd: '/w' })
    // detail 含会破坏 legacy/MarkdownV2 的字符
    bus.emit('ApprovalRequested', {
      conversationId: CID,
      approvalId: 'ap3',
      command: 'Write',
      detail: '{"file_path":"a_b.txt","content":"x*y+z"}',
    })
    await tick()

    expect(mock.sent.length).toBe(1)
    // 降级为纯文本（无 parse_mode）
    expect((mock.sent[0]!.extra as { parse_mode?: string }).parse_mode).toBeUndefined()
    // 按钮仍在
    const extra = mock.sent[0]!.extra as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
    expect(extra.reply_markup.inline_keyboard[0]!.map(b => b.callback_data)).toEqual(['approve:ap3', 'reject:ap3'])
    // 不冒泡错误
    expect(errors.length).toBe(0)
  })

  test('审批卡 detail 含反斜杠（Windows 路径）→ 双写转义不丢', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hi', message_id: 1 } })
    bus.emit('SessionCreated', { conversationId: CID, platform: 'telegram', userId: '42', cli: 'claude', cwd: '/w' })
    bus.emit('ApprovalRequested', {
      conversationId: CID,
      approvalId: 'ap4',
      command: 'Write',
      detail: '{"file_path":"D:\\\\Users\\\\sheepyu\\\\hello.txt","content":"hi"}',
    })
    await tick()

    expect(mock.sent.length).toBe(1)
    // 审批卡文本不含反斜杠时路径将显示为 D:Userssheepyuhello.txt（\\ 被 MarkdownV2 吞掉）
    // 此处验证双写后路径完整（含 \\）
    expect(mock.sent[0]!.text).toContain('D:\\\\')
    expect(mock.sent[0]!.text).toContain('Users\\\\')
  })
})
