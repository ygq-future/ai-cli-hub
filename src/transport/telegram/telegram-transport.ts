/**
 * TelegramTransport —— Telegram 客户端接入（Telegraf），实现 shared 的 Transport（契约 §2）。
 *
 * 入站：白名单校验（非白名单静默丢弃，不进 Core）→ /start /help 静态回复 → 普通文本 emit
 *       MessageReceived（不含 conversationId，D13）。
 * 出站：订阅 MessageGenerated（D12 累计全文，按会话维护草稿 ref 流式 editMessage）与
 *       ApprovalRequested（sendApproval 审批卡 + 内联按钮）；按钮回调 → emit
 *       ApprovalApproved | ApprovalRejected 并把卡片改写为终态（幂等）。
 *
 * conversationId ↔ chatId 映射（纯内存）：入站记 userChat；订阅 SessionCreated 建 convChat。
 * 依赖矩阵：transport/ 只依赖 event/shared/config + 平台 SDK，禁 core/storage。
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Telegraf } from 'telegraf'
import telegramify from 'telegramify-markdown'
import type { AppConfig } from '../../config'
import type { EventBus } from '../../event'
import { DEFAULT_AUTO_APPROVE_SECONDS } from '../../shared'
import { getHelpText, getLanguageChangedText, getLanguageUsageText, getStartText } from '../messages'
import { sanitizeFileName, withTimeout } from '../utils'
import type {
  ApprovalCard,
  CliType,
  CopyAction,
  ConversationId,
  InboundAttachment,
  InboundCustomEmoji,
  InboundSticker,
  MediaPreprocessor,
  MessageRef,
  Platform,
  Transport,
  Unsubscribe,
  UserLanguage,
} from '../../shared'

// —— 最小结构化 bot 接口（便于测试注入假 bot；真 Telegraf 经 cast 赋值）——
interface TgCtx {
  from?: { id: number | string }
  chat?: { id: number | string }
  message?: TgMessage
  match?: RegExpExecArray | null
  reply(text: string, extra?: unknown): Promise<unknown>
  answerCbQuery(text?: string): Promise<unknown>
}
interface TelegramApprovalMeta {
  conversationId: ConversationId
  chatId: string
  userId: string
  card: ApprovalCard
  ref?: MessageRef
  resolved: boolean
  countdownTimer: ReturnType<typeof setInterval> | null
}
interface TgMessageEntity {
  type: string
  offset: number
  length: number
  custom_emoji_id?: string
}
interface TgPhotoSize {
  file_id: string
  file_unique_id?: string
  width?: number
  height?: number
  file_size?: number
}
interface TgDocument {
  file_id: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
}
interface TgDownloadableMedia {
  file_id: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
}
interface TgAudio extends TgDownloadableMedia {
  title?: string
  performer?: string
  duration?: number
}
interface TgVoice extends TgDownloadableMedia {
  duration?: number
}
interface TgVideo extends TgDownloadableMedia {
  width?: number
  height?: number
  duration?: number
}
interface TgVideoNote extends TgDownloadableMedia {
  length?: number
  duration?: number
}
interface TgAnimation extends TgDownloadableMedia {
  width?: number
  height?: number
  duration?: number
}
interface TgSticker {
  file_id: string
  file_unique_id?: string
  type?: string
  width?: number
  height?: number
  emoji?: string
  set_name?: string
  custom_emoji_id?: string
  is_animated?: boolean
  is_video?: boolean
  file_size?: number
}
interface TgMessage {
  text?: string
  caption?: string
  message_id?: number
  entities?: TgMessageEntity[]
  caption_entities?: TgMessageEntity[]
  photo?: TgPhotoSize[]
  document?: TgDocument
  audio?: TgAudio
  voice?: TgVoice
  video?: TgVideo
  video_note?: TgVideoNote
  animation?: TgAnimation
  sticker?: TgSticker
  media_group_id?: string
}
interface TgFileInfo {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_path?: string
}
interface TgApi {
  sendMessage(chatId: string | number, text: string, extra?: unknown): Promise<{ message_id: number }>
  editMessageText(
    chatId: string | number,
    messageId: number,
    inlineId: undefined,
    text: string,
    extra?: unknown,
  ): Promise<unknown>
  deleteMessage(chatId: string | number, messageId: number): Promise<unknown>
  getFile?(fileId: string): Promise<TgFileInfo>
  getFileLink?(fileId: string): Promise<URL | string>
}
export interface TelegramBotLike {
  telegram: TgApi
  start(h: (ctx: TgCtx) => unknown): unknown
  help(h: (ctx: TgCtx) => unknown): unknown
  on(filter: unknown, h: (ctx: TgCtx) => unknown): unknown
  action(trigger: RegExp, h: (ctx: TgCtx) => unknown): unknown
  launch(onLaunch?: () => void): Promise<void>
  stop(reason?: string): void
}

export interface TelegramTransportDeps {
  bus: EventBus
  config: AppConfig
  /** 注入的 bot（测试用假 bot）；缺省用真 Telegraf。 */
  bot?: TelegramBotLike
  /** 媒体预处理器（Composition Root 注入具体实现；缺省为原文透传）。 */
  mediaPreprocessor?: MediaPreprocessor
  /** 测试注入：绕过真实 Telegram 文件下载。 */
  downloadTelegramFile?: (file: TelegramDownloadRequest) => Promise<string>
  /** 用户语言持久化查询；缺省使用 Transport 内存偏好（测试/兼容）。 */
  resolveUserLanguage?: (platform: Platform, userId: string) => Promise<UserLanguage>
  /** 测试可缩短重连等待；生产默认 2 秒起、最多 60 秒。 */
  pollingRetryInitialMs?: number
  pollingRetryMaxMs?: number
}

export interface TelegramTransport extends Transport {
  getUserLanguage(userId: string): UserLanguage
}

const TELEGRAM_SAFE_TEXT_LIMIT = 3800
const POLLING_STABLE_RESET_MS = 60_000
interface TelegramDownloadRequest {
  fileId: string
  fileUniqueId?: string
  fileName?: string
  fileSize?: number
  mimeType?: string
  kind: InboundAttachment['kind']
}

function isNotModified(err: unknown): boolean {
  return String(err).includes('message is not modified')
}

/** Telegram 400 解析实体错误（MarkdownV2 转义边界漏网时触发），据此降级为纯文本重发。 */
function isParseEntitiesError(err: unknown): boolean {
  return String(err).includes("can't parse entities")
}

function telegramErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const value = err as { code?: unknown; response?: { error_code?: unknown } }
  const code = value.code ?? value.response?.error_code
  return typeof code === 'number' ? code : undefined
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = tableCells(line)
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

function formatMarkdownTableRow(headers: string[], row: string[]): string {
  const [name = '', ...rest] = row
  const details = rest
    .map((cell, index) => {
      const header = headers[index + 1]
      return header ? `${header} ${cell}` : cell
    })
    .filter(Boolean)
    .join('，')
  return details ? `- ${name}：${details}` : `- ${name}`
}

function normalizeMarkdownTables(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const next = lines[i + 1] ?? ''
    if (line.trim().startsWith('|') && isMarkdownTableSeparator(next)) {
      const headers = tableCells(line)
      i += 2
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        out.push(formatMarkdownTableRow(headers, tableCells(lines[i] ?? '')))
        i++
      }
      i--
      continue
    }
    out.push(line)
  }

  return out.join('\n')
}

function normalizeWindowsPathSlashes(content: string): string {
  return content.replace(/\b([A-Za-z]:)\\+([^\n`"'<>]*)/g, (_match: string, drive: string, rest: string) => {
    const normalizedRest = rest.replace(/\\+/g, '/')
    return `${drive}/${normalizedRest}`
  })
}

/**
 * 把 Claude 输出的 GitHub 风格 Markdown 转成 Telegram MarkdownV2（telegramify-markdown）。
 * 该库保证输出可解析（残缺 markdown 也转义为字面量，流式半句不会 400）。
 * 转换失败时降级为纯文本（不带 parse_mode），确保消息永不丢失。
 */
function fmt(content: string): { text: string; extra?: { parse_mode: 'MarkdownV2' } } {
  const normalized = normalizeWindowsPathSlashes(normalizeMarkdownTables(content))
  try {
    return { text: telegramify(normalized, 'escape'), extra: { parse_mode: 'MarkdownV2' } }
  } catch {
    return { text: normalized }
  }
}

export function createTelegramTransport(deps: TelegramTransportDeps): TelegramTransport {
  const { bus, config } = deps
  const bot = deps.bot ?? (new Telegraf(config.TELEGRAM_BOT_TOKEN) as unknown as TelegramBotLike)
  const whitelist = new Set(config.WHITELIST_USER_IDS)
  const mediaPreprocessor =
    deps.mediaPreprocessor ??
    ({
      preprocess(input) {
        return Promise.resolve({ text: input.text, warnings: [] })
      },
    } satisfies MediaPreprocessor)

  const userChat = new Map<string, string>() // userId → chatId
  const userLang = new Map<string, UserLanguage>() // userId → lang
  const userCli = new Map<string, CliType>() // userId → current cli target
  const userCwd = new Map<string, string>() // userId → current cwd target
  const convChat = new Map<string, string>() // conversationId → chatId
  const convUser = new Map<string, string>() // conversationId → userId
  const drafts = new Map<string, { ref: MessageRef; lastContent: string }>() // 当前流式草稿
  const approvals = new Map<string, TelegramApprovalMeta>()
  const mediaGroups = new Map<
    string,
    { contexts: TgCtx[]; timer: ReturnType<typeof setTimeout>; firstMessageId: number }
  >()
  const unsubs: Unsubscribe[] = []
  const pollingRetryInitialMs = Math.max(1, deps.pollingRetryInitialMs ?? 2_000)
  const pollingRetryMaxMs = Math.max(pollingRetryInitialMs, deps.pollingRetryMaxMs ?? 60_000)
  let stopping = false
  let launchTask: Promise<void> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let resolveRetryWait: (() => void) | null = null

  function reportError(scope: string, err: unknown) {
    bus.emit('ErrorOccurred', { scope, message: err instanceof Error ? err.message : String(err) })
  }

  function waitBeforePollingRetry(delayMs: number): Promise<void> {
    return new Promise(resolve => {
      resolveRetryWait = resolve
      retryTimer = setTimeout(() => {
        retryTimer = null
        resolveRetryWait = null
        resolve()
      }, delayMs)
    })
  }

  function cancelPollingRetryWait(): void {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    const resolve = resolveRetryWait
    resolveRetryWait = null
    resolve?.()
  }

  async function supervisePolling(): Promise<void> {
    let retryDelayMs = pollingRetryInitialMs
    while (!stopping) {
      bus.emit('TransportStatusChanged', { platform: 'telegram', state: 'connecting' })
      let failure: unknown
      let readyAt: number | undefined
      try {
        await bot.launch(() => {
          readyAt = Date.now()
          bus.emit('TransportStatusChanged', { platform: 'telegram', state: 'ready' })
        })
        if (stopping) return
        failure = new Error('Telegram polling stopped unexpectedly.')
      } catch (err) {
        if (stopping) return
        failure = err
      }

      reportError('telegram:launch', failure)
      if (telegramErrorCode(failure) === 401) {
        bus.emit('TransportStatusChanged', {
          platform: 'telegram',
          state: 'stopped',
          detail: 'Telegram bot token was rejected (401); automatic reconnect disabled.',
        })
        return
      }

      if (readyAt && Date.now() - readyAt >= POLLING_STABLE_RESET_MS) retryDelayMs = pollingRetryInitialMs

      const detail = failure instanceof Error ? failure.message : String(failure)
      bus.emit('TransportStatusChanged', {
        platform: 'telegram',
        state: 'reconnecting',
        detail: `${detail}; retrying in ${retryDelayMs}ms`,
      })
      await waitBeforePollingRetry(retryDelayMs)
      retryDelayMs = Math.min(retryDelayMs * 2, pollingRetryMaxMs)
    }
  }

  function getUserLanguage(userId: string): UserLanguage {
    return userLang.get(userId) ?? 'zh'
  }

  async function resolvedUserLanguage(userId: string): Promise<UserLanguage> {
    return deps.resolveUserLanguage?.('telegram', userId) ?? getUserLanguage(userId)
  }

  function parseCommandName(text: string): string | null {
    const head = text.trim().split(/\s+/)[0]
    if (!head?.startsWith('/')) return null
    return head.slice(1).split('@')[0]?.toLowerCase() ?? null
  }

  function targetCli(userId: string): CliType {
    return userCli.get(userId) ?? 'claude'
  }

  function targetCwd(userId: string): string {
    return userCwd.get(userId) ?? process.cwd()
  }

  function inferExt(file: TelegramDownloadRequest, url?: string): string {
    const fromName = path.extname(file.fileName ?? '')
    if (fromName) return fromName
    const fromUrl = url ? path.extname(new URL(url).pathname) : ''
    if (fromUrl) return fromUrl
    if (file.mimeType?.startsWith('image/')) return `.${file.mimeType.slice('image/'.length).replace('jpeg', 'jpg')}`
    if (file.mimeType?.startsWith('audio/')) return `.${file.mimeType.slice('audio/'.length).replace('mpeg', 'mp3')}`
    if (file.mimeType?.startsWith('video/')) return `.${file.mimeType.slice('video/'.length)}`
    return file.kind === 'photo' ? '.jpg' : ''
  }

  async function defaultDownloadTelegramFile(file: TelegramDownloadRequest): Promise<string> {
    if (file.fileSize && file.fileSize > config.MEDIA_MAX_FILE_BYTES) {
      throw new Error(`文件过大：${file.fileSize} bytes，限制 ${config.MEDIA_MAX_FILE_BYTES} bytes。`)
    }
    if (!bot.telegram.getFileLink) throw new Error('Telegram getFileLink API is unavailable.')

    const link = await bot.telegram.getFileLink(file.fileId)
    const url = String(link)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Telegram 文件下载失败：HTTP ${response.status}`)

    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > config.MEDIA_MAX_FILE_BYTES) {
      throw new Error(`文件过大：${bytes.byteLength} bytes，限制 ${config.MEDIA_MAX_FILE_BYTES} bytes。`)
    }

    const baseName = file.fileName ?? `${file.fileUniqueId ?? file.fileId}${inferExt(file, url)}`
    const dir = path.resolve(config.MEDIA_DOWNLOAD_DIR)
    await mkdir(dir, { recursive: true })
    const localPath = path.join(dir, `${Date.now()}-${sanitizeFileName(baseName, 'telegram-file')}`)
    await Bun.write(localPath, bytes)
    return localPath
  }

  function downloadTelegramFile(file: TelegramDownloadRequest): Promise<string> {
    return withTimeout(
      (deps.downloadTelegramFile ?? defaultDownloadTelegramFile)(file),
      config.MEDIA_PARSE_TIMEOUT_MS,
      'Telegram file download',
    )
  }

  /** 白名单闸门：非白名单静默丢弃（不回任何提示）。 */
  function guarded(h: (ctx: TgCtx) => unknown): (ctx: TgCtx) => unknown {
    return ctx => {
      const uid = ctx.from?.id
      if (uid == null || !whitelist.has(String(uid))) return
      return h(ctx)
    }
  }

  // —— 出站原语 ——
  async function doSend(chatId: string, content: string, extra?: unknown): Promise<MessageRef> {
    const msg = await bot.telegram.sendMessage(chatId, content, extra)
    return { platform: 'telegram', chatId, nativeId: String(msg.message_id) }
  }

  async function replyFormatted(ctx: TgCtx, content: string): Promise<unknown> {
    const { text, extra } = fmt(content)
    try {
      return await ctx.reply(text, extra)
    } catch (err) {
      if (!isParseEntitiesError(err)) throw err
      return await ctx.reply(content)
    }
  }
  async function doEdit(ref: MessageRef, content: string, extra?: unknown): Promise<void> {
    if (!content) return
    try {
      await bot.telegram.editMessageText(ref.chatId, Number(ref.nativeId), undefined, content, extra)
    } catch (err) {
      if (!isNotModified(err)) throw err
    }
  }

  // —— 对话消息出站：MarkdownV2 渲染 + 解析失败降级纯文本（telegramify 漏转义某字符时的安全网）——
  function splitText(text: string): string[] {
    if (text.length <= TELEGRAM_SAFE_TEXT_LIMIT) return [text]
    const chunks: string[] = []
    let rest = text
    while (rest.length > TELEGRAM_SAFE_TEXT_LIMIT) {
      const window = rest.slice(0, TELEGRAM_SAFE_TEXT_LIMIT)
      const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '))
      const size = cut > TELEGRAM_SAFE_TEXT_LIMIT * 0.6 ? cut : TELEGRAM_SAFE_TEXT_LIMIT
      chunks.push(rest.slice(0, size))
      rest = rest.slice(size).trimStart()
    }
    if (rest) chunks.push(rest)
    return chunks
  }

  function isMessageTooLong(err: unknown): boolean {
    return String(err).includes('message is too long')
  }

  async function sendPlainChunks(chatId: string, raw: string, extra?: unknown): Promise<MessageRef> {
    let firstRef: MessageRef | null = null
    for (const [index, chunk] of splitText(raw).entries()) {
      const ref = await doSend(chatId, chunk, index === 0 ? extra : undefined)
      firstRef ??= ref
    }
    return firstRef ?? (await doSend(chatId, ''))
  }

  async function editPlainChunks(ref: MessageRef, raw: string): Promise<void> {
    const [first = '', ...rest] = splitText(raw)
    await doEdit(ref, first)
    for (const chunk of rest) {
      await doSend(ref.chatId, chunk)
    }
  }

  async function sendFormatted(chatId: string, raw: string, copyActions?: CopyAction[]): Promise<MessageRef> {
    if (copyActions?.length) return sendCopyActionPages(chatId, raw, copyActions)
    return sendFormattedPage(chatId, raw)
  }

  async function sendFormattedPage(chatId: string, raw: string, replyMarkup?: unknown): Promise<MessageRef> {
    const plain = normalizeWindowsPathSlashes(normalizeMarkdownTables(raw))
    const { text, extra } = fmt(raw)
    const sendExtra = mergeTelegramExtra(extra, replyMarkup)
    const plainExtra = mergeTelegramExtra(undefined, replyMarkup)
    try {
      if (text.length > TELEGRAM_SAFE_TEXT_LIMIT) return sendPlainChunks(chatId, plain, plainExtra)
      return await doSend(chatId, text, sendExtra)
    } catch (err) {
      if (isMessageTooLong(err)) return sendPlainChunks(chatId, plain, plainExtra)
      if (isParseEntitiesError(err)) return sendPlainChunks(chatId, plain, plainExtra) // 降级：纯文本
      throw err
    }
  }

  async function sendCopyActionPages(chatId: string, raw: string, actions: CopyAction[]): Promise<MessageRef> {
    const pages = chunkCopyActions(actions)
    let firstRef: MessageRef | null = null
    for (const [index, page] of pages.entries()) {
      const content = index === 0 ? raw : `## 🤖 可用模型（续 ${index + 1}/${pages.length}）`
      const ref = await sendFormattedPage(chatId, content, copyActionKeyboard(page))
      firstRef ??= ref
    }
    return firstRef!
  }
  async function editFormatted(ref: MessageRef, raw: string): Promise<void> {
    const plain = normalizeWindowsPathSlashes(normalizeMarkdownTables(raw))
    const { text, extra } = fmt(raw)
    try {
      if (text.length > TELEGRAM_SAFE_TEXT_LIMIT) {
        await editPlainChunks(ref, plain)
        return
      }
      await doEdit(ref, text, extra)
    } catch (err) {
      if (isMessageTooLong(err)) {
        await editPlainChunks(ref, plain)
        return
      }
      if (isParseEntitiesError(err)) {
        await editPlainChunks(ref, plain)
        return
      }
      throw err
    }
  }
  async function doDelete(ref: MessageRef): Promise<void> {
    await bot.telegram.deleteMessage(ref.chatId, Number(ref.nativeId))
  }
  function approvalKeyboard(card: ApprovalCard) {
    const buttons = card.autoApproveAt
      ? [{ text: '❌ 拒绝本轮', callback_data: `reject:${card.approvalId}` }]
      : [
          { text: '✅ Approve', callback_data: `approve:${card.approvalId}` },
          { text: '❌ Reject', callback_data: `reject:${card.approvalId}` },
        ]
    return { inline_keyboard: [buttons] }
  }

  function approvalMarkdown(card: ApprovalCard, remainingSeconds?: number): string {
    const detail = card.detail || 'Claude 请求执行上述操作。'
    if (card.autoApproveAt) {
      const remaining = remainingSeconds ?? Math.max(1, Math.ceil((card.autoApproveAt - Date.now()) / 1000))
      return `⚠️ **自动审批已开启**\n\n⏳ 将在 **${remaining} 秒后**自动批准；点击下方按钮会拒绝并中断本轮操作。\n\n命令：\`${card.command}\`\n\n说明：${detail}`
    }
    return `⚠️ **需要授权**\n\n命令：\`${card.command}\`\n\n说明：${detail}`
  }

  async function editApprovalCard(ref: MessageRef, card: ApprovalCard, remainingSeconds: number): Promise<void> {
    const md = approvalMarkdown(card, remainingSeconds)
    const keyboard = approvalKeyboard(card)
    const { text, extra } = fmt(md)
    try {
      await doEdit(ref, text, { ...extra, reply_markup: keyboard })
    } catch (err) {
      if (!isParseEntitiesError(err)) throw err
      await doEdit(ref, md, { reply_markup: keyboard })
    }
  }

  async function doSendApproval(chatId: string, card: ApprovalCard): Promise<MessageRef> {
    const keyboard = approvalKeyboard(card)
    // GFM 卡面经 telegramify → MarkdownV2；command/detail（工具名+参数）含特殊字符也被安全转义
    const md = approvalMarkdown(card)
    const { text, extra } = fmt(md)
    try {
      return await doSend(chatId, text, { ...extra, reply_markup: keyboard })
    } catch (err) {
      if (!isParseEntitiesError(err)) throw err
      // 降级：纯文本卡面（保留审批按钮），确保授权流不因渲染失败而中断
      const plain = md.replace(/[*`]/g, '')
      return doSend(chatId, plain, { reply_markup: keyboard })
    }
  }

  function extractCustomEmojis(message: TgMessage, sourceText: string): InboundCustomEmoji[] {
    const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])]
    return entities
      .filter(e => e.type === 'custom_emoji' && e.custom_emoji_id)
      .map(e => ({
        customEmojiId: e.custom_emoji_id!,
        text: sourceText.slice(e.offset, e.offset + e.length),
      }))
  }

  function extractSticker(message: TgMessage): InboundSticker[] {
    const sticker = message.sticker
    if (!sticker) return []
    return [
      {
        emoji: sticker.emoji,
        setName: sticker.set_name,
        customEmojiId: sticker.custom_emoji_id,
        isAnimated: sticker.is_animated ?? false,
        isVideo: sticker.is_video ?? false,
        fileId: sticker.file_id,
        fileUniqueId: sticker.file_unique_id,
        width: sticker.width,
        height: sticker.height,
        fileSize: sticker.file_size,
      },
    ]
  }

  function chooseLargestPhoto(photos: TgPhotoSize[] | undefined): TgPhotoSize | null {
    if (!photos?.length) return null
    return [...photos].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0] ?? null
  }

  async function extractAttachments(message: TgMessage): Promise<InboundAttachment[]> {
    const attachments: InboundAttachment[] = []

    async function addDownloadable(kind: InboundAttachment['kind'], file: TgDownloadableMedia): Promise<void> {
      const localPath = await downloadTelegramFile({
        kind,
        fileId: file.file_id,
        fileUniqueId: file.file_unique_id,
        fileName: file.file_name,
        fileSize: file.file_size,
        mimeType: file.mime_type,
      })
      attachments.push({
        kind,
        fileId: file.file_unique_id,
        fileName: file.file_name,
        mimeType: file.mime_type,
        fileSize: file.file_size,
        localPath,
      })
    }

    const photo = chooseLargestPhoto(message.photo)
    if (photo) {
      const localPath = await downloadTelegramFile({
        kind: 'photo',
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id,
        fileSize: photo.file_size,
        mimeType: 'image/jpeg',
      })
      attachments.push({
        kind: 'photo',
        fileId: photo.file_unique_id,
        fileSize: photo.file_size,
        mimeType: 'image/jpeg',
        localPath,
      })
    }

    if (message.document) await addDownloadable('document', message.document)
    if (message.audio) await addDownloadable('audio', message.audio)
    if (message.voice) await addDownloadable('voice', message.voice)
    if (message.video) await addDownloadable('video', message.video)
    if (message.video_note) await addDownloadable('video_note', message.video_note)
    if (message.animation) await addDownloadable('animation', message.animation)

    return attachments
  }

  async function emitIncoming(ctx: TgCtx, text: string, attachments?: InboundAttachment[]): Promise<void> {
    const userId = String(ctx.from?.id ?? '')
    const chatId = String(ctx.chat?.id ?? '')
    if (!userId || !chatId) return
    userChat.set(userId, chatId)

    const commandName = parseCommandName(text)
    if (commandName === 'start') {
      void replyFormatted(ctx, getStartText(await resolvedUserLanguage(userId))).catch(() => {})
      return
    }
    if (commandName === 'help') {
      void replyFormatted(ctx, getHelpText(await resolvedUserLanguage(userId))).catch(() => {})
      return
    }
    if (commandName === 'lang') {
      const lang = text.trim().split(/\s+/)[1] as UserLanguage | undefined
      if (lang !== 'zh' && lang !== 'en') {
        void replyFormatted(ctx, getLanguageUsageText(await resolvedUserLanguage(userId))).catch(() => {})
        return
      }
      userLang.set(userId, lang)
      bus.emit('UserLanguageChanged', { userId, platform: 'telegram', language: lang })
      void replyFormatted(ctx, getLanguageChangedText(lang)).catch(() => {})
      return
    }

    bus.emit('MessageReceived', {
      userId,
      platform: 'telegram',
      cli: targetCli(userId),
      cwd: targetCwd(userId),
      text,
      ref: { platform: 'telegram', chatId, nativeId: String(ctx.message?.message_id ?? '') },
      ...(attachments?.length ? { attachments } : {}),
    })
  }

  async function processIncoming(contexts: TgCtx[]): Promise<void> {
    const firstContext = contexts[0]
    if (!firstContext) return
    const messages = contexts
      .map(context => context.message)
      .filter((message): message is TgMessage => Boolean(message))
    const text = messages
      .map(message => message.text ?? message.caption ?? '')
      .filter(Boolean)
      .join('\n')
    const attachments = (await Promise.all(messages.map(message => extractAttachments(message)))).flat()
    const result = await withTimeout(
      mediaPreprocessor.preprocess({
        text,
        customEmojis: messages.flatMap(message => extractCustomEmojis(message, message.text ?? message.caption ?? '')),
        stickers: messages.flatMap(extractSticker),
        attachments,
      }),
      config.MEDIA_PARSE_TIMEOUT_MS,
      'Media preprocessing',
    )
    await emitIncoming(firstContext, result.text, attachments)
  }

  async function onIncoming(ctx: TgCtx): Promise<void> {
    const message = ctx.message
    if (!message) return

    const userId = String(ctx.from?.id ?? '')
    const chatId = String(ctx.chat?.id ?? '')
    if (!userId || !chatId) return
    userChat.set(userId, chatId)

    const commandName = message.text ? parseCommandName(message.text) : null
    if (commandName) {
      await emitIncoming(ctx, message.text ?? '')
      return
    }

    try {
      if (message.media_group_id) {
        const key = `${chatId}:${message.media_group_id}`
        const pending = mediaGroups.get(key)
        if (pending) {
          pending.contexts.push(ctx)
          clearTimeout(pending.timer)
          pending.timer = setTimeout(() => void flushMediaGroup(key), 350)
        } else {
          mediaGroups.set(key, {
            contexts: [ctx],
            firstMessageId: message.message_id ?? 0,
            timer: setTimeout(() => void flushMediaGroup(key), 350),
          })
        }
        return
      }
      await processIncoming([ctx])
    } catch (err) {
      reportError('telegram:media', err)
      void ctx.reply(`附件处理失败：${err instanceof Error ? err.message : String(err)}`).catch(() => {})
    }
  }

  async function flushMediaGroup(key: string): Promise<void> {
    const pending = mediaGroups.get(key)
    if (!pending) return
    mediaGroups.delete(key)
    try {
      pending.contexts.sort(
        (a, b) => (a.message?.message_id ?? pending.firstMessageId) - (b.message?.message_id ?? pending.firstMessageId),
      )
      await processIncoming(pending.contexts)
    } catch (err) {
      reportError('telegram:mediaGroup', err)
      const first = pending.contexts[0]
      if (first) void first.reply(`附件处理失败：${err instanceof Error ? err.message : String(err)}`).catch(() => {})
    }
  }

  function onAction(ctx: TgCtx) {
    const m = ctx.match
    const decision = m?.[1]
    const approvalId = m?.[2]
    if (!decision || !approvalId) {
      void ctx.answerCbQuery().catch(() => {})
      return
    }
    const meta = approvals.get(approvalId)
    if (!meta || meta.resolved) {
      void ctx.answerCbQuery('已处理').catch(() => {})
      return // 幂等：重复点击只生效一次
    }
    meta.resolved = true
    if (meta.countdownTimer) clearInterval(meta.countdownTimer)
    meta.countdownTimer = null
    const operator = String(ctx.from?.id ?? '')
    if (decision === 'approve') {
      bus.emit('ApprovalApproved', { conversationId: meta.conversationId, approvalId, operator })
    } else {
      bus.emit('ApprovalRejected', { conversationId: meta.conversationId, approvalId, operator })
    }
    const label = decision === 'approve' ? '✅ 已批准' : '❌ 已拒绝'
    if (meta.ref)
      void doEdit(meta.ref, `⚠️ 需要授权 — ${label}（by ${operator}）`, {
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {})
    void ctx.answerCbQuery(decision === 'approve' ? '已批准' : '已拒绝').catch(() => {})
  }

  // 注册 bot handlers（创建期注册；launch 在 start()）
  bot.start(
    guarded(async ctx => replyFormatted(ctx, getStartText(await resolvedUserLanguage(String(ctx.from?.id ?? ''))))),
  )
  bot.help(
    guarded(async ctx => replyFormatted(ctx, getHelpText(await resolvedUserLanguage(String(ctx.from?.id ?? ''))))),
  )
  bot.on(
    'message',
    guarded(ctx => void onIncoming(ctx).catch(err => reportError('telegram:incoming', err))),
  )
  bot.action(/^(approve|reject):(.+)$/, guarded(onAction))

  // —— 出站订阅 ——
  function rememberSession(p: {
    conversationId?: ConversationId
    platform?: Platform
    userId: string
    cli?: CliType
    cwd?: string
  }) {
    if (p.platform && p.platform !== 'telegram') return
    const chatId = userChat.get(p.userId)
    if (chatId && p.conversationId) {
      convChat.set(p.conversationId, chatId)
      convUser.set(p.conversationId, p.userId)
    }
    if (p.cli) userCli.set(p.userId, p.cli)
    if (p.cwd) userCwd.set(p.userId, p.cwd)
  }

  unsubs.push(bus.on('SessionCreated', rememberSession))
  unsubs.push(bus.on('SessionMapped', rememberSession))
  unsubs.push(bus.on('UserTargetChanged', rememberSession))

  unsubs.push(
    bus.on('CommandReply', async p => {
      if (p.ref.platform !== 'telegram') return
      try {
        await sendFormatted(p.ref.chatId, p.content, p.copyActions)
      } catch (err) {
        reportError('telegram:CommandReply', err)
      }
    }),
  )

  unsubs.push(
    bus.on('MessageGenerated', async p => {
      const chatId = convChat.get(p.conversationId)
      if (!chatId) return // 无 chatId 映射（如跨重启复用旧会话），无法路由
      try {
        const draft = drafts.get(p.conversationId)
        if (!p.final) {
          if (!draft) {
            const ref = await sendFormatted(chatId, p.content)
            drafts.set(p.conversationId, { ref, lastContent: p.content })
          } else if (draft.lastContent !== p.content) {
            await editFormatted(draft.ref, p.content)
            draft.lastContent = p.content
          }
        } else {
          // final：定稿当前草稿并清 ref（拆分时下一条 final=false 重新 sendMessage）
          if (draft) {
            if (draft.lastContent !== p.content) await editFormatted(draft.ref, p.content)
            drafts.delete(p.conversationId)
          } else if (p.content) {
            await sendFormatted(chatId, p.content)
          }
        }
      } catch (err) {
        reportError('telegram:MessageGenerated', err)
      }
    }),
  )

  unsubs.push(
    bus.on('ApprovalRequested', async p => {
      const chatId = convChat.get(p.conversationId)
      if (!chatId) return
      const userId = convUser.get(p.conversationId) ?? chatId
      const card: ApprovalCard = {
        approvalId: p.approvalId,
        title: '需要授权',
        command: p.command,
        detail: p.detail,
        ...(p.autoApproveAt ? { autoApproveAt: p.autoApproveAt } : {}),
        ...(p.autoApproveSeconds ? { autoApproveSeconds: p.autoApproveSeconds } : {}),
      }
      const meta: TelegramApprovalMeta = {
        conversationId: p.conversationId,
        chatId,
        userId,
        card,
        resolved: false,
        countdownTimer: null,
      }
      approvals.set(p.approvalId, meta)
      try {
        meta.ref = await doSendApproval(chatId, card)
        if (meta.resolved || !card.autoApproveAt) return
        meta.countdownTimer = setInterval(() => {
          if (meta.resolved || !meta.ref || !card.autoApproveAt) return
          const remaining = Math.max(0, Math.ceil((card.autoApproveAt - Date.now()) / 1000))
          if (remaining <= 0) {
            if (meta.countdownTimer) clearInterval(meta.countdownTimer)
            meta.countdownTimer = null
            return
          }
          void editApprovalCard(meta.ref, card, remaining).catch(err => reportError('telegram:approvalCountdown', err))
        }, 1_000)
      } catch (err) {
        reportError('telegram:ApprovalRequested', err)
      }
    }),
  )

  unsubs.push(
    bus.on('ApprovalApproved', p => {
      if (!p.automatic) return
      const meta = approvals.get(p.approvalId)
      if (!meta || meta.resolved) return
      meta.resolved = true
      if (meta.countdownTimer) clearInterval(meta.countdownTimer)
      meta.countdownTimer = null
      if (meta.ref)
        void doEdit(meta.ref, '⚡ 自动审批倒计时已结束 — ✅ 已批准', {
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {})
      const seconds = meta.card.autoApproveSeconds ?? DEFAULT_AUTO_APPROVE_SECONDS
      void resolvedUserLanguage(meta.userId)
        .then(language =>
          sendFormatted(
            meta.chatId,
            language === 'en'
              ? `## ✅ Automatically approved\n\nThe ${seconds}-second countdown ended and \`${meta.card.command}\` was approved automatically.`
              : `## ✅ 已自动审批\n\n${seconds} 秒倒计时已结束，\`${meta.card.command}\` 已自动批准。`,
          ),
        )
        .catch(err => reportError('telegram:autoApprovalResult', err))
    }),
  )

  return {
    platform: 'telegram',

    start() {
      if (launchTask) return Promise.resolve()
      stopping = false
      bus.emit('TransportStatusChanged', { platform: 'telegram', state: 'starting' })
      const task = supervisePolling()
      launchTask = task
      void task.then(() => {
        if (launchTask === task) launchTask = null
      })
      return Promise.resolve()
    },

    async stop() {
      stopping = true
      cancelPollingRetryWait()
      for (const group of mediaGroups.values()) clearTimeout(group.timer)
      mediaGroups.clear()
      for (const approval of approvals.values()) {
        if (approval.countdownTimer) clearInterval(approval.countdownTimer)
      }
      for (const u of unsubs) u()
      unsubs.length = 0
      try {
        bot.stop()
      } catch (err) {
        reportError('telegram:stop', err)
      }
      await launchTask
      bus.emit('TransportStatusChanged', { platform: 'telegram', state: 'stopped' })
    },

    sendMessage: (chatId, content) => doSend(chatId, content),
    editMessage: (ref, content) => doEdit(ref, content),
    deleteMessage: ref => doDelete(ref),
    sendApproval: (chatId, card) => doSendApproval(chatId, card),
    getUserLanguage,
  }
}

const TELEGRAM_COPY_BUTTONS_PER_MESSAGE = 100

function chunkCopyActions(actions: CopyAction[]): CopyAction[][] {
  const chunks: CopyAction[][] = []
  for (let index = 0; index < actions.length; index += TELEGRAM_COPY_BUTTONS_PER_MESSAGE) {
    chunks.push(actions.slice(index, index + TELEGRAM_COPY_BUTTONS_PER_MESSAGE))
  }
  return chunks
}

function copyActionKeyboard(actions: CopyAction[]) {
  return {
    inline_keyboard: actions.map(action => [{ text: `📋 ${action.label}`, copy_text: { text: action.copyText } }]),
  }
}

function mergeTelegramExtra(extra: unknown, replyMarkup: unknown): unknown {
  if (!replyMarkup) return extra
  const base = extra && typeof extra === 'object' && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {}
  return { ...base, reply_markup: replyMarkup }
}
