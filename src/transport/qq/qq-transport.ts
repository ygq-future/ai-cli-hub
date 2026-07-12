/** 腾讯官方 QQ Bot Transport：仅 C2C 私聊，行为与 TelegramTransport 同构。 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { AppConfig } from '../../config'
import type { EventBus } from '../../event'
import { getHelpText, getStartText } from '../messages'
import { sanitizeFileName, withTimeout } from '../utils'
import type {
  CliType,
  ConversationId,
  InboundAttachment,
  MediaPreprocessor,
  MessageRef,
  Platform,
  Transport,
  Unsubscribe,
  UserLanguage,
} from '../../shared'
import {
  createQQBotClient,
  type QQBotClient,
  type QQGatewayEvent,
  type QQGatewayStatusUpdate,
  type QQKeyboard,
} from './qq-bot-client'

interface QQInboundContext {
  userId: string
  chatId: string
  messageId: string
  eventId: string
}

interface QQDraft {
  context: QQInboundContext
  streamMessageId: string
  sequence: number
  index: number
  lastContent: string
}

export interface QQTransportDeps {
  bus: EventBus
  config: AppConfig
  client?: QQBotClient
  /** 媒体预处理器（Composition Root 注入；缺省为原文透传）。 */
  mediaPreprocessor?: MediaPreprocessor
  /** 测试注入：绕过真实 QQ 附件下载。 */
  downloadQQFile?: (url: string, opts: { fileName?: string; fileSize?: number }) => Promise<string>
  /** 用户语言持久化查询；缺省使用 Transport 内存偏好（测试/兼容）。 */
  resolveUserLanguage?: (platform: Platform, userId: string) => Promise<UserLanguage>
}

export interface QQTransport extends Transport {
  getUserLanguage(userId: string): UserLanguage
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function parseCommandName(text: string): string | null {
  const head = text.trim().split(/\s+/)[0]
  return head?.startsWith('/') ? (head.slice(1).toLowerCase() ?? null) : null
}

function randomSequence(): number {
  return Math.floor(Math.random() * 65_536)
}

/** 将 QQ 附件 content_type 映射为共享附件 kind。表情包（GIF/PNG/JPEG）归入 photo。 */
function mapQQContentType(contentType: unknown): InboundAttachment['kind'] {
  const t = String(contentType ?? '').toLowerCase()
  if (t.startsWith('image/')) return 'photo'
  if (t === 'file') return 'document'
  if (t === 'voice') return 'voice'
  if (t.startsWith('video/')) return 'video'
  return 'other'
}

/** 把 opencode / claude 的审批 detail JSON 精简为 2-3 行可读摘要，避免 QQ 消息被大段 JSON 淹没。 */
function summarizeApprovalDetail(detail: string): string {
  try {
    const obj = JSON.parse(detail) as Record<string, unknown>
    const lines: string[] = []

    // claude: { command, description }
    if (typeof obj.command === 'string') lines.push(`命令：${obj.command}`)
    if (typeof obj.description === 'string' && obj.description) lines.push(`说明：${obj.description}`)

    // opencode: { permission: "bash"|"edit"|..., patterns, metadata, tool, always }
    if (typeof obj.permission === 'string') {
      const meta = (obj.metadata as Record<string, unknown>) ?? {}

      if (typeof meta.command === 'string' && meta.command) {
        lines.push(`命令：${meta.command}`)
      }
      if (typeof meta.filepath === 'string') lines.push(`文件：${meta.filepath}`)
      if (typeof meta.diff === 'string') {
        const added = (meta.diff.match(/^\+(?!\+\+)/gm) ?? []).length
        const removed = (meta.diff.match(/^-(?!--)/gm) ?? []).length
        lines.push(`变更：+${added}/-${removed} 行`)
      }
    }

    if (Array.isArray(obj.always) && (obj.always as string[]).includes('*')) {
      lines.push('(此工具已设为始终允许，后续调用将不再询问)')
    }

    if (lines.length > 0) return lines.join('\n')
    // 别的 CLI / adapter：展示所有顶层 string 键（最多 3 个）
    const flat: string[] = []
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') flat.push(`${k}：${v}`)
      if (flat.length >= 3) break
    }
    if (flat.length > 0) return flat.join('\n')
  } catch {
    // 不是 JSON，就是纯文本说明
  }
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail
}

function approvalKeyboard(approvalId: string): QQKeyboard {
  const button = (id: string, label: string, style: 0 | 1, decision: 'approve' | 'reject') => ({
    id,
    render_data: { label, visited_label: decision === 'approve' ? '已批准' : '已拒绝', style },
    action: {
      type: 1 as const,
      data: `ai-cli-hub:${decision}:${approvalId}`,
      permission: { type: 2 as const },
      click_limit: 1 as const,
    },
  })
  return {
    content: {
      rows: [{ buttons: [button('approve', '✅ Approve', 1, 'approve'), button('reject', '❌ Reject', 0, 'reject')] }],
    },
  }
}

export function createQQTransport(deps: QQTransportDeps): QQTransport {
  const { bus, config } = deps
  const client =
    deps.client ??
    createQQBotClient({
      appId: config.QQBOT_APP_ID,
      appSecret: config.QQBOT_APP_SECRET,
      wsProxy: config.QQBOT_WS_PROXY || undefined,
    })
  const mediaPreprocessor =
    deps.mediaPreprocessor ??
    ({
      preprocess(input) {
        return Promise.resolve({ text: input.text, warnings: [] })
      },
    } satisfies MediaPreprocessor)
  const whitelist = new Set(config.WHITELIST_USER_IDS)
  const userContext = new Map<string, QQInboundContext>()
  const userLang = new Map<string, UserLanguage>()
  const userCli = new Map<string, CliType>()
  const userCwd = new Map<string, string>()
  const convContext = new Map<ConversationId, QQInboundContext>()
  const drafts = new Map<ConversationId, QQDraft>()
  const approvals = new Map<string, { conversationId: ConversationId; chatId: string; resolved: boolean }>()
  const discoveredOpenIds = new Set<string>()
  const unsubs: Unsubscribe[] = []

  function reportError(scope: string, err: unknown) {
    bus.emit('ErrorOccurred', { scope, message: err instanceof Error ? err.message : String(err) })
  }
  function reportGatewayStatus(status: QQGatewayStatusUpdate) {
    bus.emit('TransportStatusChanged', { platform: 'qq', ...status })
  }
  function getUserLanguage(userId: string): UserLanguage {
    return userLang.get(userId) ?? 'zh'
  }
  async function resolvedUserLanguage(userId: string): Promise<UserLanguage> {
    return deps.resolveUserLanguage?.('qq', userId) ?? getUserLanguage(userId)
  }
  function targetCli(userId: string): CliType {
    return userCli.get(userId) ?? 'claude'
  }
  function targetCwd(userId: string): string {
    return userCwd.get(userId) ?? process.cwd()
  }

  async function defaultDownloadQQFile(url: string, opts: { fileName?: string; fileSize?: number }): Promise<string> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`QQ 文件下载失败：HTTP ${response.status}`)
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > config.MEDIA_MAX_FILE_BYTES) {
      throw new Error(`文件过大：${bytes.byteLength} bytes，限制 ${config.MEDIA_MAX_FILE_BYTES} bytes。`)
    }
    const baseName = opts.fileName ?? `qq-file-${crypto.randomUUID().slice(0, 8)}`
    const dir = path.resolve(config.MEDIA_DOWNLOAD_DIR)
    await mkdir(dir, { recursive: true })
    const localPath = path.join(dir, `${Date.now()}-${sanitizeFileName(baseName, 'qq-file')}`)
    await Bun.write(localPath, bytes)
    return localPath
  }

  function downloadQQFile(url: string, opts: { fileName?: string; fileSize?: number }): Promise<string> {
    if (opts.fileSize && opts.fileSize > config.MEDIA_MAX_FILE_BYTES) {
      throw new Error(`文件过大：${opts.fileSize} bytes，限制 ${config.MEDIA_MAX_FILE_BYTES} bytes。`)
    }
    return withTimeout(
      (deps.downloadQQFile ?? defaultDownloadQQFile)(url, opts),
      config.MEDIA_PARSE_TIMEOUT_MS,
      'QQ file download',
    )
  }

  function rememberSession(p: {
    conversationId?: ConversationId
    platform?: Platform
    userId: string
    cli?: CliType
    cwd?: string
  }) {
    if (p.platform && p.platform !== 'qq') return
    const context = userContext.get(p.userId)
    if (p.conversationId && context) convContext.set(p.conversationId, context)
    if (p.cli) userCli.set(p.userId, p.cli)
    if (p.cwd) userCwd.set(p.userId, p.cwd)
  }
  async function sendToContext(context: QQInboundContext, content: string, keyboard?: QQKeyboard): Promise<MessageRef> {
    const response = await client.sendC2CMessage(context.chatId, content, context.messageId, keyboard)
    return { platform: 'qq', chatId: context.chatId, nativeId: response.id }
  }
  async function emitIncoming(context: QQInboundContext, text: string) {
    const command = parseCommandName(text)
    if (command === 'start')
      return void sendToContext(context, getStartText(await resolvedUserLanguage(context.userId))).catch(err =>
        reportError('qq:start', err),
      )
    if (command === 'help')
      return void sendToContext(context, getHelpText(await resolvedUserLanguage(context.userId))).catch(err =>
        reportError('qq:help', err),
      )
    if (command === 'lang') {
      const language = text.trim().split(/\s+/)[1] as UserLanguage | undefined
      if (language !== 'zh' && language !== 'en') {
        return void sendToContext(context, '用法：/lang zh 或 /lang en').catch(err => reportError('qq:lang', err))
      }
      userLang.set(context.userId, language)
      bus.emit('UserLanguageChanged', { userId: context.userId, platform: 'qq', language })
      return void sendToContext(
        context,
        language === 'zh' ? '已切换为中文回复。' : 'Language switched to English.',
      ).catch(err => reportError('qq:lang', err))
    }
    bus.emit('MessageReceived', {
      userId: context.userId,
      platform: 'qq',
      cli: targetCli(context.userId),
      cwd: targetCwd(context.userId),
      text,
      ref: { platform: 'qq', chatId: context.chatId, nativeId: context.messageId },
    })
  }
  async function onC2CMessage(data: Record<string, unknown>) {
    const author = asRecord(data.author)
    const userId = String(author.user_openid ?? data.author_openid ?? '')
    const messageId = String(data.id ?? '')
    const eventId = String(data.event_id ?? data.id ?? '')
    if (!userId || !messageId) return
    if (!whitelist.has(userId)) {
      if (config.QQBOT_OPENID_DISCOVERY && !discoveredOpenIds.has(userId)) {
        discoveredOpenIds.add(userId)
        bus.emit('ErrorOccurred', {
          scope: 'qq:openid-discovery',
          message: `未授权 QQ C2C 用户 OpenID: ${userId}。确认后将其加入 WHITELIST_USER_IDS，并关闭 QQBOT_OPENID_DISCOVERY。`,
        })
      }
      return
    }
    const context: QQInboundContext = { userId, chatId: userId, messageId, eventId }
    userContext.set(userId, context)

    const text = String(data.content ?? '')
    const rawAttachments: Array<Record<string, unknown>> = Array.isArray(data.attachments) ? data.attachments : []

    // 命令直接走发布流程（不经过媒体预处理）
    const commandName = text ? parseCommandName(text) : null
    if (commandName) {
      await emitIncoming(context, text)
      return
    }

    // —— 媒体入站：下载附件 + ASR 文本 + 媒体预处理（与 TG 同构）——
    try {
      const attachments: InboundAttachment[] = []
      for (const att of rawAttachments) {
        const url = String(att.url ?? '')
        if (!url) continue
        const fileName = att.filename ? String(att.filename) : undefined
        const fileSize = typeof att.size === 'number' ? att.size : undefined
        const mimeType = att.content_type ? String(att.content_type) : undefined
        const kind = mapQQContentType(mimeType)
        const localPath = await downloadQQFile(url, { fileName, fileSize })
        attachments.push({
          kind,
          fileId: url,
          fileName,
          mimeType,
          fileSize,
          localPath,
        })
      }

      // QQ 语音消息内置 ASR，文本直接注入
      const asrTexts = rawAttachments
        .filter(a => a.asr_refer_text)
        .map(a => `[Voice ASR: ${a.asr_refer_text}]`)
        .join('\n')
      const fullText = [text, asrTexts].filter(Boolean).join('\n') || '[media message]'

      const result = await withTimeout(
        mediaPreprocessor.preprocess({
          text: fullText,
          attachments,
        }),
        config.MEDIA_PARSE_TIMEOUT_MS,
        'QQ media preprocessing',
      )
      await emitIncoming(context, result.text)
    } catch (err) {
      reportError('qq:media', err)
      void sendToContext(context, `附件处理失败：${err instanceof Error ? err.message : String(err)}`).catch(() => {})
    }
  }
  function onInteraction(data: Record<string, unknown>) {
    const resolved = asRecord(asRecord(data.data).resolved)
    const buttonData = String(resolved.button_data ?? '')
    const interactionId = String(data.id ?? '')
    const match = /^ai-cli-hub:(approve|reject):(.+)$/.exec(buttonData)
    const operator = String(data.user_openid ?? resolved.user_id ?? '')
    if (!match || !operator || !whitelist.has(operator)) return

    const [, decision, approvalId] = match
    const approval = approvals.get(approvalId!)

    // 已审批过的按钮再次点击：ACK 正常返回（不转圈），但提示"已处理过"。
    if (!approval || approval.resolved) {
      if (interactionId) {
        void client.ackInteraction(interactionId).catch(err => reportError('qq:interaction-ack', err))
      }
      void client
        .sendC2CMessage(operator, '此次审批已处理过，无需重复操作。')
        .catch(err => reportError('qq:approval-result', err))
      return
    }

    // QQ 要求 5 秒内 ACK，否则客户端一直转圈并提示"请求第三方失败"。
    // 先发 ACK，再执行业务逻辑（审批动作）。
    if (interactionId) {
      void client.ackInteraction(interactionId).catch(err => reportError('qq:interaction-ack', err))
    }

    approval.resolved = true
    if (decision === 'approve')
      bus.emit('ApprovalApproved', { conversationId: approval.conversationId, approvalId: approvalId!, operator })
    else bus.emit('ApprovalRejected', { conversationId: approval.conversationId, approvalId: approvalId!, operator })
    void client
      .sendC2CMessage(
        approval.chatId,
        decision === 'approve' ? `✅ 已批准（by ${operator}）` : `❌ 已拒绝（by ${operator}）`,
      )
      .catch(err => reportError('qq:approval-result', err))
  }
  function onGatewayEvent(event: QQGatewayEvent) {
    if (event.type === 'C2C_MESSAGE_CREATE') void onC2CMessage(event.data).catch(err => reportError('qq:c2c', err))
    if (event.type === 'INTERACTION_CREATE') onInteraction(event.data)
  }

  unsubs.push(bus.on('SessionCreated', rememberSession))
  unsubs.push(bus.on('SessionMapped', rememberSession))
  unsubs.push(bus.on('UserTargetChanged', rememberSession))
  unsubs.push(
    bus.on('CommandReply', p => {
      if (p.ref.platform !== 'qq') return
      const context = userContext.get(p.ref.chatId)
      if (!context) return
      void sendToContext(context, p.content).catch(err => reportError('qq:CommandReply', err))
    }),
  )
  unsubs.push(
    bus.on('MessageGenerated', p => {
      const context = convContext.get(p.conversationId)
      if (!context) return
      const draft = drafts.get(p.conversationId)
      const send = async () => {
        if (!draft) {
          if (!p.content) return
          const sequence = randomSequence()
          const response = await client.sendC2CStreamMessage(context.chatId, {
            eventId: context.eventId,
            messageId: context.messageId,
            content: p.content,
            sequence,
            index: 0,
            final: p.final,
          })
          if (!p.final)
            drafts.set(p.conversationId, {
              context,
              streamMessageId: response.id,
              sequence,
              index: 1,
              lastContent: p.content,
            })
          return
        }
        if (draft.lastContent !== p.content || p.final) {
          await client.sendC2CStreamMessage(draft.context.chatId, {
            eventId: draft.context.eventId,
            messageId: draft.context.messageId,
            content: p.content,
            streamMessageId: draft.streamMessageId,
            sequence: draft.sequence,
            index: draft.index++,
            final: p.final,
          })
          draft.lastContent = p.content
        }
        if (p.final) drafts.delete(p.conversationId)
      }
      void send().catch(err => reportError('qq:MessageGenerated', err))
    }),
  )
  unsubs.push(
    bus.on('ApprovalRequested', p => {
      const context = convContext.get(p.conversationId)
      if (!context) return
      // opencode 的 detail 是 JSON（包含 diff / filepath / metadata 等），直接展示太杂乱；
      // claude 的 detail 是 JSON（command / description），同样需要提取。
      const summary = summarizeApprovalDetail(p.detail)
      // 当 summary 第一行恰好和 p.command 相同时去重，避免重复行。
      const firstLine = summary.split('\n')[0] ?? ''
      const dedupedSummary = firstLine === `命令：${p.command}` ? summary.split('\n').slice(1).join('\n') : summary
      const content = [`⚠️ 需要授权`, '', `命令：${p.command}`, dedupedSummary].filter(Boolean).join('\n')
      void sendToContext(context, content, approvalKeyboard(p.approvalId))
        .then(() =>
          approvals.set(p.approvalId, { conversationId: p.conversationId, chatId: context.chatId, resolved: false }),
        )
        .catch(err => reportError('qq:ApprovalRequested', err))
    }),
  )

  return {
    platform: 'qq',
    async start() {
      bus.emit('TransportStatusChanged', {
        platform: 'qq',
        state: 'starting',
        detail: '正在启动腾讯官方 QQ Bot Transport',
      })
      try {
        await client.start(onGatewayEvent, reportGatewayStatus)
      } catch (err) {
        reportError('qq:gateway:start', err)
        throw err
      }
    },
    async stop() {
      for (const unsubscribe of unsubs) unsubscribe()
      unsubs.length = 0
      await client.stop()
    },
    async sendMessage(chatId, content) {
      const context = userContext.get(chatId)
      if (context) return sendToContext(context, content)
      // 重启通知等主动消息没有本进程内的入站上下文；QQ C2C 支持不带 msg_id 的主动发送。
      const response = await client.sendC2CMessage(chatId, content)
      return { platform: 'qq', chatId, nativeId: response.id }
    },
    async editMessage(ref, content) {
      const context = userContext.get(ref.chatId)
      if (context) {
        await sendToContext(context, content)
        return
      }
      await client.sendC2CMessage(ref.chatId, content)
    },
    async deleteMessage() {
      // QQ C2C API does not expose a generic delete-message endpoint; no-op keeps Transport contract portable.
    },
    async sendApproval(chatId, card) {
      const context = userContext.get(chatId)
      if (!context) throw new Error(`No QQ C2C context for ${chatId}.`)
      return sendToContext(
        context,
        `⚠️ ${card.title}\n\n命令：${card.command}\n\n说明：${card.detail}`,
        approvalKeyboard(card.approvalId),
      )
    },
    getUserLanguage,
  }
}
