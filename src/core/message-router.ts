/**
 * MessageRouter —— 消息路由（docs/02-Architecture.md §3.2 / §4.1）。
 *
 * 职责：
 *  - 订阅 MessageReceived 事件（决策 D13：不含 conversationId）
 *  - 经 sessionManager.findOrCreate 解析/新建会话（会话 scope = platform+userId+cli）
 *  - 保存用户消息到 DB
 *  - 交由注入的 MessageHandler 处理（M3 用 mock 回显；M6 = Composition Root 注入的
 *    真实 adapter 编排器，输出走聚合器流，handler 返回空串不自发 MessageGenerated）
 *
 * 依赖矩阵：core/ 禁依赖 cli/，故 handler 是语义接缝——具体 adapter 驱动由 Composition
 * Root（orchestrator）实现并注入。
 */
import type {
  ConversationId,
  FileContentReader,
  InboundAttachmentKind,
  Platform,
  Unsubscribe,
  UserLanguage,
} from '../shared'
import type { EventBus } from '../event'
import type { Repositories } from '../repository'
import type { CommandRouter } from './commands'
import type { SessionManager } from './session-manager'

/**
 * 用户输入处理接缝。
 *  - onMessage 接收 (text, conversationId)，返回响应文本（空串表示无同步响应——
 *    真实 adapter 场景下输出经聚合器异步流出，此处返回空串）。
 */
export interface MessageHandler {
  onMessage(text: string, conversationId: ConversationId): Promise<string>
}

export interface MessageRouter {
  destroy(): void
}

export function createMessageRouter(
  bus: EventBus,
  repos: Repositories,
  sessionManager: SessionManager,
  commandRouter?: CommandRouter,
  handler?: MessageHandler,
  getUserLanguage: (platform: Platform, userId: string) => Promise<UserLanguage> | UserLanguage = () => 'zh',
  requestedSummaryMessageLimit = 10,
  fileContentReader?: FileContentReader,
): MessageRouter {
  const unsubs: Unsubscribe[] = []

  // 订阅 MessageReceived
  const unsub = bus.on('MessageReceived', async payload => {
    const { userId, platform, cli, cwd, text } = payload
    let conversationId: ConversationId | undefined

    try {
      if (text.trim().startsWith('/') && commandRouter) {
        const handled = await commandRouter.tryHandle(payload)
        if (handled) return
      }

      // 解析/新建会话（新建时同步发 SessionCreated）
      conversationId = await sessionManager.findOrCreate({ userId, platform, cli, cwd, text })
      const registeredFiles = []
      for (const attachment of payload.attachments ?? []) {
        registeredFiles.push(
          await repos.conversationFiles.createNext({
            conversationId: conversationId as ConversationId,
            kind: attachment.kind,
            fileId: attachment.fileId,
            fileUniqueId: attachment.fileUniqueId,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            fileSize: attachment.fileSize,
            localPath: attachment.localPath,
          }),
        )
      }
      if (registeredFiles.some(file => !isImageAttachment(file.kind, file.mimeType, file.fileName, file.localPath))) {
        bus.emit('CommandReply', { ref: payload.ref, content: formatDeferredFileReply(registeredFiles) })
        return
      }
      const resolvedText = await resolveFileReferences(text, conversationId, repos, fileContentReader)
      if (!resolvedText.ok) {
        bus.emit('CommandReply', { ref: payload.ref, content: `## ❌ 文件引用失败\n\n${resolvedText.message}` })
        return
      }
      // 保存用户消息（角色=user）
      const msgId = crypto.randomUUID()
      await repos.messages.append({
        id: msgId,
        conversationId,
        role: 'user',
        content: resolvedText.text,
        createdAt: Date.now(),
      })

      if (isMemorySummaryRequest(resolvedText.text)) {
        bus.emit('MemorySummaryRequested', {
          conversationId,
          userId,
          language: await getUserLanguage(platform, userId),
          reason: 'userRememberRequest',
          text: resolvedText.text,
        })
        const response = `已收到，我会根据当前会话最近 ${requestedSummaryMessageLimit} 条消息总结成长期记忆。`
        await repos.messages.append({
          id: crypto.randomUUID(),
          conversationId,
          role: 'assistant',
          content: response,
          createdAt: Date.now(),
        })
        bus.emit('MessageGenerated', {
          conversationId,
          content: response,
          final: true,
        })
        return
      }

      const status = await sessionManager.getStatus(conversationId)
      const shouldMarkReady = status === 'idle'
      if (shouldMarkReady) await sessionManager.transition(conversationId, 'START')

      // 交由 handler 处理
      if (handler) {
        const response = await handler.onMessage(resolvedText.text, conversationId)
        if (shouldMarkReady) await sessionManager.transition(conversationId, 'ADAPTER_READY')
        if (response) {
          const respId = crypto.randomUUID()
          // 保存 assistant 消息
          await repos.messages.append({
            id: respId,
            conversationId,
            role: 'assistant',
            content: response,
            createdAt: Date.now(),
          })

          // 发射 MessageGenerated 事件
          bus.emit('MessageGenerated', {
            conversationId,
            content: response,
            final: true,
          })
        }
      } else if (shouldMarkReady) {
        await sessionManager.transition(conversationId, 'ADAPTER_READY')
      }
    } catch (err) {
      bus.emit('ErrorOccurred', {
        scope: 'router:MessageReceived',
        message: err instanceof Error ? err.message : String(err),
        ...(conversationId ? { conversationId } : {}),
      })
    }
  })
  unsubs.push(unsub)

  return {
    destroy() {
      for (const u of unsubs) u()
      unsubs.length = 0
    },
  }
}

function isImageAttachment(kind: string, mimeType: string | null, fileName: string | null, localPath: string): boolean {
  if (kind === 'photo' || mimeType?.toLowerCase().startsWith('image/')) return true
  return /\.(?:png|jpe?g|webp|bmp|tiff?)$/i.test(fileName ?? localPath)
}

function formatDeferredFileReply(files: Array<{ sequence: number; fileName: string | null }>): string {
  return [
    '## 📎 文件已暂存',
    '',
    ...files.map(file => `- **文件 ${file.sequence}**：${file.fileName ?? '未命名文件'}`),
    '',
    '使用 `@read<N>` 读取内容，例如 `@read1`；使用 `@file<N>` 仅将文件路径交给 AI，例如 `@file1`。',
  ].join('\n')
}

async function resolveFileReferences(
  text: string,
  conversationId: ConversationId,
  repos: Repositories,
  reader: FileContentReader | undefined,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const directives = [...text.matchAll(/@(read|file)(\d+)\b/gi)]
  if (directives.length === 0) return { ok: true, text }

  const replacements = new Map<string, string>()
  for (const directive of directives) {
    const raw = directive[0]
    if (replacements.has(raw)) continue
    const action = directive[1]?.toLowerCase()
    const sequence = Number(directive[2])
    const file = await repos.conversationFiles.findBySequence(conversationId, sequence)
    if (!file) return { ok: false, message: `当前会话中不存在文件 ${sequence}。可用 /file 查看已暂存文件。` }
    if (action === 'file') {
      replacements.set(
        raw,
        `[File ${sequence}: ${file.fileName ?? 'unnamed'}]\nlocal_path=${file.localPath.replace(/\\+/g, '/')}\nDo not read it automatically; use the path only if needed.`,
      )
      continue
    }
    if (!reader) return { ok: false, message: '文件读取能力尚未装配。' }
    const result = await reader.read({
      sequence: file.sequence,
      kind: parseAttachmentKind(file.kind),
      fileName: file.fileName,
      mimeType: file.mimeType,
      localPath: file.localPath,
    })
    if (result.status !== 'ok') return { ok: false, message: `文件 ${sequence} 无法读取：${result.reason}` }
    replacements.set(
      raw,
      [
        `[File ${sequence} extracted content: ${file.fileName ?? 'unnamed'}]`,
        ...(result.warnings?.length ? [`[Warnings: ${result.warnings.join('; ')}]`] : []),
        result.text,
        `[End file ${sequence}]`,
      ].join('\n'),
    )
  }
  let resolved = text
  for (const [directive, replacement] of replacements) resolved = resolved.replaceAll(directive, replacement)
  return { ok: true, text: resolved }
}

function parseAttachmentKind(kind: string): InboundAttachmentKind {
  const kinds: ReadonlySet<string> = new Set([
    'photo',
    'document',
    'audio',
    'voice',
    'video',
    'video_note',
    'animation',
    'other',
  ])
  return kinds.has(kind) ? (kind as InboundAttachmentKind) : 'other'
}

function isMemorySummaryRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized || normalized.startsWith('/')) return false
  return (
    /(?:帮我|请|麻烦)?记住/.test(normalized) ||
    /(?:帮我|请|麻烦)?记一下/.test(normalized) ||
    /(?:帮我|请|麻烦)?记录(?:一下)?/.test(normalized) ||
    /记下来/.test(normalized) ||
    /\bremember\s+(?:this|that|it|the|these|where|what)/i.test(normalized)
  )
}
