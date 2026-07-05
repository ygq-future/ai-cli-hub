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
import { Telegraf } from 'telegraf'
import { message } from 'telegraf/filters'
import telegramify from 'telegramify-markdown'
import type { AppConfig } from '../../config'
import type { EventBus } from '../../event'
import type { ApprovalCard, ConversationId, MessageRef, Transport, Unsubscribe } from '../../shared'

// —— 最小结构化 bot 接口（便于测试注入假 bot；真 Telegraf 经 cast 赋值）——
interface TgCtx {
  from?: { id: number | string }
  chat?: { id: number | string }
  message?: { text?: string; message_id?: number }
  match?: RegExpExecArray | null
  reply(text: string, extra?: unknown): Promise<unknown>
  answerCbQuery(text?: string): Promise<unknown>
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
}
export interface TelegramBotLike {
  telegram: TgApi
  start(h: (ctx: TgCtx) => unknown): unknown
  help(h: (ctx: TgCtx) => unknown): unknown
  on(filter: unknown, h: (ctx: TgCtx) => unknown): unknown
  action(trigger: RegExp, h: (ctx: TgCtx) => unknown): unknown
  launch(): Promise<void>
  stop(reason?: string): void
}

export interface TelegramTransportDeps {
  bus: EventBus
  config: AppConfig
  /** 注入的 bot（测试用假 bot）；缺省用真 Telegraf。 */
  bot?: TelegramBotLike
}

const START_TEXT =
  '👋 AI CLI Hub 已就绪。直接发消息即可与 Claude 对话；写操作会弹出授权卡片，请 Approve / Reject。\n发送 /help 查看帮助。'
const HELP_TEXT =
  '可用命令：\n/start — 欢迎与状态\n/help — 本帮助\n\n直接发送文本即可对话。会话变更类命令（/new /close /status 等）将在后续版本支持。'

function isNotModified(err: unknown): boolean {
  return String(err).includes('message is not modified')
}

/** Telegram 400 解析实体错误（MarkdownV2 转义边界漏网时触发），据此降级为纯文本重发。 */
function isParseEntitiesError(err: unknown): boolean {
  return String(err).includes("can't parse entities")
}

/**
 * 把 Claude 输出的 GitHub 风格 Markdown 转成 Telegram MarkdownV2（telegramify-markdown）。
 * 该库保证输出可解析（残缺 markdown 也转义为字面量，流式半句不会 400）。
 * 转换失败时降级为纯文本（不带 parse_mode），确保消息永不丢失。
 */
function fmt(content: string): { text: string; extra?: { parse_mode: 'MarkdownV2' } } {
  try {
    return { text: telegramify(content, 'escape'), extra: { parse_mode: 'MarkdownV2' } }
  } catch {
    return { text: content }
  }
}

export function createTelegramTransport(deps: TelegramTransportDeps): Transport {
  const { bus, config } = deps
  const bot = deps.bot ?? (new Telegraf(config.TELEGRAM_BOT_TOKEN) as unknown as TelegramBotLike)
  const whitelist = new Set(config.WHITELIST_USER_IDS)

  const userChat = new Map<string, string>() // userId → chatId
  const convChat = new Map<string, string>() // conversationId → chatId
  const drafts = new Map<string, { ref: MessageRef; lastContent: string }>() // 当前流式草稿
  const approvals = new Map<string, { conversationId: ConversationId; ref: MessageRef; resolved: boolean }>()
  const unsubs: Unsubscribe[] = []

  function reportError(scope: string, err: unknown) {
    bus.emit('ErrorOccurred', { scope, message: err instanceof Error ? err.message : String(err) })
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
  async function doEdit(ref: MessageRef, content: string, extra?: unknown): Promise<void> {
    if (!content) return
    try {
      await bot.telegram.editMessageText(ref.chatId, Number(ref.nativeId), undefined, content, extra)
    } catch (err) {
      if (!isNotModified(err)) throw err
    }
  }

  // —— 对话消息出站：MarkdownV2 渲染 + 解析失败降级纯文本（telegramify 漏转义某字符时的安全网）——
  async function sendFormatted(chatId: string, raw: string): Promise<MessageRef> {
    const { text, extra } = fmt(raw)
    try {
      return await doSend(chatId, text, extra)
    } catch (err) {
      if (isParseEntitiesError(err)) return doSend(chatId, raw) // 降级：纯文本原文
      throw err
    }
  }
  async function editFormatted(ref: MessageRef, raw: string): Promise<void> {
    const { text, extra } = fmt(raw)
    try {
      await doEdit(ref, text, extra)
    } catch (err) {
      if (isParseEntitiesError(err)) await doEdit(ref, raw)
      else throw err
    }
  }
  async function doDelete(ref: MessageRef): Promise<void> {
    await bot.telegram.deleteMessage(ref.chatId, Number(ref.nativeId))
  }
  async function doSendApproval(chatId: string, card: ApprovalCard): Promise<MessageRef> {
    // 反斜杠在 MarkdownV2/纯文本中都会被吞，双写转义保证路径完整显示
    const detail = (card.detail || 'Claude 请求执行上述操作。').replace(/\\/g, '\\\\')
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `approve:${card.approvalId}` },
          { text: '❌ Reject', callback_data: `reject:${card.approvalId}` },
        ],
      ],
    }
    // GFM 卡面经 telegramify → MarkdownV2；command/detail（工具名+参数）含特殊字符也被安全转义
    const md = `⚠️ **需要授权**\n\n命令：\`${card.command}\`\n\n说明：${detail}`
    const { text, extra } = fmt(md)
    try {
      return await doSend(chatId, text, { ...extra, reply_markup: keyboard })
    } catch (err) {
      if (!isParseEntitiesError(err)) throw err
      // 降级：纯文本卡面（保留审批按钮），确保授权流不因渲染失败而中断
      const plain = `⚠️ 需要授权\n\n命令：\n${card.command}\n\n说明：${detail}`
      return doSend(chatId, plain, { reply_markup: keyboard })
    }
  }

  // —— 入站 handlers ——
  function onText(ctx: TgCtx) {
    const text = ctx.message?.text ?? ''
    if (text.startsWith('/')) {
      // 未注册的斜杠命令（/start /help 已单独处理）——提示暂未支持
      void ctx.reply('ℹ️ 该命令即将支持。当前可直接发送文本对话，或 /help。').catch(() => {})
      return
    }
    const userId = String(ctx.from?.id ?? '')
    const chatId = String(ctx.chat?.id ?? '')
    if (!userId || !chatId) return
    userChat.set(userId, chatId)
    bus.emit('MessageReceived', {
      userId,
      platform: 'telegram',
      cli: 'claude',
      cwd: config.DEFAULT_CWD,
      text,
      ref: { platform: 'telegram', chatId, nativeId: String(ctx.message?.message_id ?? '') },
    })
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
    const operator = String(ctx.from?.id ?? '')
    if (decision === 'approve') {
      bus.emit('ApprovalApproved', { conversationId: meta.conversationId, approvalId, operator })
    } else {
      bus.emit('ApprovalRejected', { conversationId: meta.conversationId, approvalId, operator })
    }
    const label = decision === 'approve' ? '✅ 已批准' : '❌ 已拒绝'
    void doEdit(meta.ref, `⚠️ 需要授权 — ${label}（by ${operator}）`).catch(() => {})
    void ctx.answerCbQuery(decision === 'approve' ? '已批准' : '已拒绝').catch(() => {})
  }

  // 注册 bot handlers（创建期注册；launch 在 start()）
  bot.start(guarded(ctx => ctx.reply(START_TEXT)))
  bot.help(guarded(ctx => ctx.reply(HELP_TEXT)))
  bot.on(message('text'), guarded(onText))
  bot.action(/^(approve|reject):(.+)$/, guarded(onAction))

  // —— 出站订阅 ——
  unsubs.push(
    bus.on('SessionCreated', p => {
      const chatId = userChat.get(p.userId)
      if (chatId) convChat.set(p.conversationId, chatId)
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
      try {
        const ref = await doSendApproval(chatId, {
          approvalId: p.approvalId,
          title: '需要授权',
          command: p.command,
          detail: p.detail,
        })
        approvals.set(p.approvalId, { conversationId: p.conversationId, ref, resolved: false })
      } catch (err) {
        reportError('telegram:ApprovalRequested', err)
      }
    }),
  )

  return {
    platform: 'telegram',

    async start() {
      // launch() 的 Promise 在 bot 停止时才 resolve，故不 await
      void bot.launch().catch(err => reportError('telegram:launch', err))
    },

    async stop() {
      for (const u of unsubs) u()
      unsubs.length = 0
      try {
        bot.stop()
      } catch (err) {
        reportError('telegram:stop', err)
      }
    },

    sendMessage: (chatId, content) => doSend(chatId, content),
    editMessage: (ref, content) => doEdit(ref, content),
    deleteMessage: ref => doDelete(ref),
    sendApproval: (chatId, card) => doSendApproval(chatId, card),
  }
}
