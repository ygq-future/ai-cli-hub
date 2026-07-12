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
    DATABASE_URL: 'postgres://x',
    EMBEDDING_API_KEY: 'k',
    EMBEDDING_MODEL: 'BAAI/bge-m3',
    EMBEDDING_DIMENSIONS: 1024,
    MEMORY_RECALL_TOP_K: 10,
    AGENT_IDLE_TIMEOUT_MS: 300000,
    SESSION_ARCHIVE_DAYS: 7,
    MEDIA_DOWNLOAD_DIR: '.data/media',
    MEDIA_MAX_FILE_BYTES: 10 * 1024 * 1024,
    MEDIA_MAX_TEXT_CHARS: 20_000,
    MEDIA_PARSE_TIMEOUT_MS: 30_000,
    LOG_LEVEL: 'info',
  } as unknown as AppConfig
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
  test('白名单文本 → emit MessageReceived（不含 conversationId，D13）', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hello', message_id: 5 } })
    await tick()

    expect(received).toEqual([
      {
        userId: '42',
        platform: 'telegram',
        cli: 'claude',
        cwd: process.cwd(),
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

  test('/start（白名单）回复欢迎，不 emit MessageReceived', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))
    const replies: string[] = []

    mock.handlers.start!({ from: { id: 42 }, chat: { id: 42 }, reply: async (t: string) => replies.push(t) })
    await tick()

    expect(replies.length).toBe(1)
    expect(replies[0]).toContain('AI CLI Hub')
    expect(received.length).toBe(0)
  })

  test('系统斜杠命令 → emit MessageReceived 交给 Core', () => {
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
      reply: async (text: string) => replies.push(text),
    })

    expect(received).toEqual([
      {
        userId: '42',
        platform: 'telegram',
        cli: 'claude',
        cwd: process.cwd(),
        text: '/status',
        ref: { platform: 'telegram', chatId: '42', nativeId: '1' },
      },
    ])
    expect(replies.length).toBe(0)
  })

  test('/lang zh|en 本地切换语言偏好，不 emit', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    const transport = createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const received: unknown[] = []
    const changed: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))
    bus.on('UserLanguageChanged', p => changed.push(p))
    const replies: Array<{ text: string; extra?: unknown }> = []

    mock.handlers.text!({
      from: { id: 42 },
      chat: { id: 42 },
      message: { text: '/lang en', message_id: 1 },
      reply: async (text: string, extra?: unknown) => replies.push({ text, extra }),
    })
    await tick()

    expect(transport.getUserLanguage('42')).toBe('en')
    expect(received.length).toBe(0)
    expect(changed).toEqual([{ userId: '42', platform: 'telegram', language: 'en' }])
    expect(replies).toHaveLength(1)
    expect(replies[0]!.text).toContain('Language updated')
    expect(replies[0]!.extra).toEqual({ parse_mode: 'MarkdownV2' })
  })

  test('切换英语后 /help 使用英语共享帮助文案', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })
    const replies: string[] = []
    const context = {
      from: { id: 42 },
      chat: { id: 42 },
      message: { text: '/lang en', message_id: 1 },
      reply: async (text: string) => replies.push(text),
    }

    mock.handlers.text!(context)
    mock.handlers.help!(context)
    await tick()

    expect(replies.at(-1)).toContain('Available commands')
  })

  test('SessionCreated 后更新当前目标 cwd，后续普通消息沿用新 cwd', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))

    mock.handlers.text!({
      from: { id: 42 },
      chat: { id: 42 },
      message: { text: '/new /tmp/other-project', message_id: 1 },
    })
    await tick()
    bus.emit('SessionCreated', {
      conversationId: CID,
      platform: 'telegram',
      userId: '42',
      cli: 'claude',
      cwd: '/tmp/other-project',
    })
    mock.handlers.text!({ from: { id: 42 }, chat: { id: 42 }, message: { text: 'hello', message_id: 2 } })
    await tick()

    expect((received[0] as Record<string, unknown>).cwd).toBe(process.cwd())
    expect((received[1] as Record<string, unknown>).cwd).toBe('/tmp/other-project')
  })

  test('UserTargetChanged 后更新当前目标 cwd，后续普通消息沿用新 cwd', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 42 }, message: { text: '/cwd /srv/app', message_id: 1 } })
    await tick()
    bus.emit('UserTargetChanged', { userId: '42', platform: 'telegram', cwd: '/srv/app' })
    mock.handlers.text!({ from: { id: 42 }, chat: { id: 42 }, message: { text: 'hello', message_id: 2 } })
    await tick()

    expect((received[0] as Record<string, unknown>).cwd).toBe(process.cwd())
    expect((received[1] as Record<string, unknown>).cwd).toBe('/srv/app')
  })

  test('Unicode emoji 文本经媒体预处理后再 emit', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({
      bus,
      config: fakeConfig(),
      bot: mock.bot,
      mediaPreprocessor: {
        async preprocess(input) {
          return { text: `${input.text}\nemoji-context`, warnings: [] }
        },
      },
    })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: '今天好累 😭', message_id: 5 } })
    await tick()

    expect((received[0] as Record<string, unknown>).text).toBe('今天好累 😭\nemoji-context')
  })

  test('Sticker metadata 经媒体预处理进入 MessageReceived', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    const seen: unknown[] = []
    createTelegramTransport({
      bus,
      config: fakeConfig(),
      bot: mock.bot,
      mediaPreprocessor: {
        async preprocess(input) {
          seen.push(input.stickers?.[0])
          return { text: 'sticker context', warnings: [] }
        },
      },
    })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))

    mock.handlers.text!({
      from: { id: 42 },
      chat: { id: 1000 },
      message: {
        message_id: 6,
        sticker: {
          file_id: 'sf1',
          file_unique_id: 'su1',
          emoji: '👍',
          set_name: 'ok_set',
          is_animated: true,
          is_video: false,
          width: 512,
          height: 512,
        },
      },
    })
    await tick()

    expect(seen[0]).toMatchObject({
      fileId: 'sf1',
      fileUniqueId: 'su1',
      emoji: '👍',
      setName: 'ok_set',
      isAnimated: true,
      isVideo: false,
    })
    expect((received[0] as Record<string, unknown>).text).toBe('sticker context')
  })

  test('Photo 下载到受控路径后作为附件上下文传入预处理', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    const seen: unknown[] = []
    createTelegramTransport({
      bus,
      config: fakeConfig(),
      bot: mock.bot,
      downloadTelegramFile: async file => `D:/media/${file.fileId}.jpg`,
      mediaPreprocessor: {
        async preprocess(input) {
          seen.push(input.attachments?.[0])
          return { text: 'photo context', warnings: [] }
        },
      },
    })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))

    mock.handlers.text!({
      from: { id: 42 },
      chat: { id: 1000 },
      message: {
        message_id: 7,
        caption: '识别这张图',
        photo: [
          { file_id: 'small', file_unique_id: 's', file_size: 10 },
          { file_id: 'large', file_unique_id: 'l', file_size: 100 },
        ],
      },
    })
    await tick()

    expect(seen[0]).toMatchObject({
      kind: 'photo',
      fileId: 'large',
      fileUniqueId: 'l',
      fileSize: 100,
      mimeType: 'image/jpeg',
      localPath: 'D:/media/large.jpg',
    })
    expect((received[0] as Record<string, unknown>).text).toBe('photo context')
  })

  test('Audio 作为可下载附件保存并传入预处理', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    const seen: unknown[] = []
    createTelegramTransport({
      bus,
      config: fakeConfig(),
      bot: mock.bot,
      downloadTelegramFile: async file => `D:/media/${file.fileName ?? file.fileId}`,
      mediaPreprocessor: {
        async preprocess(input) {
          seen.push(input.attachments?.[0])
          return { text: 'audio context', warnings: [] }
        },
      },
    })

    const received: unknown[] = []
    bus.on('MessageReceived', p => received.push(p))

    mock.handlers.text!({
      from: { id: 42 },
      chat: { id: 1000 },
      message: {
        message_id: 8,
        audio: {
          file_id: 'audio-file',
          file_unique_id: 'audio-unique',
          file_name: '稳稳的幸福（DJ）.mp3',
          mime_type: 'audio/mpeg',
          file_size: 2048,
          title: '稳稳的幸福（DJ）',
          performer: '未知艺术家',
          duration: 422,
        },
      },
    })
    await tick()

    expect(seen[0]).toMatchObject({
      kind: 'audio',
      fileId: 'audio-file',
      fileUniqueId: 'audio-unique',
      fileName: '稳稳的幸福（DJ）.mp3',
      mimeType: 'audio/mpeg',
      fileSize: 2048,
      localPath: 'D:/media/稳稳的幸福（DJ）.mp3',
    })
    expect((received[0] as Record<string, unknown>).text).toBe('audio context')
  })

  test('非白名单媒体消息不会触发下载', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    let downloaded = false
    createTelegramTransport({
      bus,
      config: fakeConfig(),
      bot: mock.bot,
      downloadTelegramFile: async () => {
        downloaded = true
        return 'x'
      },
    })

    mock.handlers.text!({
      from: { id: 999 },
      chat: { id: 999 },
      message: { message_id: 1, photo: [{ file_id: 'p', file_size: 1 }] },
    })
    await tick()

    expect(downloaded).toBe(false)
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

  test('GitHub 风格表格 → Telegram 可读列表（避免原样显示管道表）', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hi', message_id: 1 } })
    bus.emit('SessionCreated', { conversationId: CID, platform: 'telegram', userId: '42', cli: 'claude', cwd: '/w' })

    bus.emit('MessageGenerated', {
      conversationId: CID,
      content: '### 文件夹\n| 名称 | 说明 |\n|------|------|\n| **Java** | Java 相关 |',
      final: true,
    })
    await tick()

    expect(mock.sent.length).toBe(1)
    const out = mock.sent[0]!.text
    expect(out).not.toContain('|------|')
    expect(out).not.toContain('| 名称 | 说明 |')
    expect(out).toContain('Java')
    expect(out).toContain('Java 相关')
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

  test('SessionMapped 建立跨重启映射后可发送回复', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: '/status', message_id: 1 } })
    bus.emit('SessionMapped', { conversationId: CID, platform: 'telegram', userId: '42' })
    bus.emit('MessageGenerated', { conversationId: CID, content: 'mapped', final: true })
    await tick()

    expect(mock.sent.length).toBe(1)
    expect(mock.sent[0]!.chatId).toBe('1000')
    expect(mock.sent[0]!.text.trim()).toBe('mapped')
  })

  test('CommandReply → 回原 chat', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    bus.emit('CommandReply', {
      ref: { platform: 'telegram', chatId: '1000', nativeId: '1' },
      content: 'status ok',
    })
    await tick()

    expect(mock.sent.length).toBe(1)
    expect(mock.sent[0]!.chatId).toBe('1000')
    expect(mock.sent[0]!.text.trim()).toBe('status ok')
  })

  test('Windows 路径展示为正斜杠且保留 MarkdownV2 渲染', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    bus.emit('CommandReply', {
      ref: { platform: 'telegram', chatId: '1000', nativeId: '1' },
      content: 'CWD: **位置** `D:\\Users\\sheepyu\\cladue-workspace\\ai-cli-hub`',
    })
    await tick()

    expect(mock.sent.length).toBe(1)
    expect(mock.sent[0]!.text).toContain('D:/Users/sheepyu')
    expect(mock.sent[0]!.text).not.toContain('D:\\Users')
    expect(mock.sent[0]!.text).toContain('*位置*')
    expect(mock.sent[0]!.text).not.toContain('**位置**')
    expect((mock.sent[0]!.extra as { parse_mode?: string }).parse_mode).toBe('MarkdownV2')
  })

  test('含 Windows 路径的真实回复仍渲染粗体和行内代码', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    bus.emit('CommandReply', {
      ref: { platform: 'telegram', chatId: '1000', nativeId: '1' },
      content:
        '刚才我按你的要求创建了文件 `a.txt`,这是它的情况:\n\n- **文件位置**:`D:\\Users\\sheepyu\\cladue-workspace\\a.txt`\n- **文件内容**:一行文本 `hello`',
    })
    await tick()

    expect(mock.sent.length).toBe(1)
    const out = mock.sent[0]!.text
    expect(out).toContain('*文件位置*')
    expect(out).not.toContain('**文件位置**')
    expect(out).toContain('D:/Users/sheepyu')
    expect(out).not.toContain('D:\\Users')
    expect(out).toContain('`hello`')
    expect((mock.sent[0]!.extra as { parse_mode?: string }).parse_mode).toBe('MarkdownV2')
  })

  test('超长回复自动分段发送，不冒泡 message is too long', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })

    const errors: unknown[] = []
    bus.on('ErrorOccurred', p => errors.push(p))

    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hi', message_id: 1 } })
    bus.emit('SessionCreated', { conversationId: CID, platform: 'telegram', userId: '42', cli: 'claude', cwd: '/w' })
    bus.emit('MessageGenerated', { conversationId: CID, content: 'x '.repeat(2500), final: true })
    await tick()

    expect(mock.sent.length).toBeGreaterThan(1)
    expect(mock.sent.every(s => s.text.length <= 3800)).toBe(true)
    expect(errors.length).toBe(0)
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

  test('自动审批卡只显示拒绝按钮，自动通过后另发结果通知', async () => {
    const bus = createEventBus()
    const mock = createMockBot()
    const transport = createTelegramTransport({ bus, config: fakeConfig(), bot: mock.bot })
    mock.handlers.text!({ from: { id: 42 }, chat: { id: 1000 }, message: { text: 'hi', message_id: 1 } })
    bus.emit('SessionCreated', { conversationId: CID, platform: 'telegram', userId: '42', cli: 'claude', cwd: '/w' })

    bus.emit('ApprovalRequested', {
      conversationId: CID,
      approvalId: 'auto-tg',
      command: 'Bash',
      detail: '{"cmd":"ls"}',
      autoApproveAt: Date.now() + 5_000,
      autoApproveSeconds: 9,
    })
    await tick()
    const extra = mock.sent[0]!.extra as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
    expect(extra.reply_markup.inline_keyboard[0]!.map(button => button.callback_data)).toEqual(['reject:auto-tg'])

    bus.emit('ApprovalApproved', {
      conversationId: CID,
      approvalId: 'auto-tg',
      operator: 'auto:42',
      automatic: true,
    })
    await tick()
    expect(mock.edited.some(item => item.text.includes('自动审批倒计时已结束'))).toBe(true)
    expect(mock.sent.some(item => item.text.includes('已自动审批'))).toBe(true)
    expect(mock.sent.some(item => item.text.includes('9 秒'))).toBe(true)
    await transport.stop()
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

  test('审批卡 detail 含 Windows 路径 → 展示为正斜杠且授权流不中断', async () => {
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
    expect(mock.sent[0]!.text).toContain('D:/Users/sheepyu/hello')
    expect(mock.sent[0]!.text).not.toContain('D:\\')
    expect((mock.sent[0]!.extra as { parse_mode?: string }).parse_mode).toBe('MarkdownV2')
  })
})
