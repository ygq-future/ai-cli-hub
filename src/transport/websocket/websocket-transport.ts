import type { EventBus } from '../../event'
import type {
  ApprovalCard,
  CliType,
  ConversationId,
  InboundAttachment,
  MediaPreprocessor,
  Platform,
  Transport,
  Unsubscribe,
  UserLanguage,
} from '../../shared'
import { getHelpText } from '../messages'

export interface WebSocketPeer {
  send(data: string): void
  close(): void
}

export interface WebSocketGateway {
  setReceiver(receiver: (peer: WebSocketPeer, data: string) => void): void
  broadcast(data: string): number
  waitForPeer(): Promise<void>
  add(peer: WebSocketPeer): boolean
  remove(peer: WebSocketPeer): void
  receive(peer: WebSocketPeer, data: string): void
}

export interface WebSocketTransportDeps {
  bus: EventBus
  gateway: WebSocketGateway
  userId: string
  cli?: CliType
  cwd?: string
  resolveUserTarget?: (platform: Platform, userId: string) => Promise<{ cli: CliType; cwd: string }>
  resolveUploads?: (ids: readonly string[]) => Promise<InboundAttachment[]>
  mediaPreprocessor?: MediaPreprocessor
  resolveUserLanguage?: (platform: Platform, userId: string) => Promise<UserLanguage> | UserLanguage
}

interface ClientEnvelope {
  v?: unknown
  type?: unknown
  text?: unknown
  approvalId?: unknown
  conversationId?: unknown
  uploadIds?: unknown
  clientMessageId?: unknown
}

interface ApprovalResolvedEnvelope {
  conversationId: ConversationId
  approvalId: string
  status: 'approved' | 'rejected'
  operator: string
  automatic: boolean
}

const MAX_TEXT_CHARS = 64 * 1024
const MAX_UPLOAD_IDS = 10
const MAX_IDENTIFIER_CHARS = 128

export function createWebSocketTransport(deps: WebSocketTransportDeps): Transport {
  const cli = deps.cli ?? 'claude'
  const cwd = deps.cwd ?? '/'
  const unsubs: Unsubscribe[] = []
  const conversations = new Set<ConversationId>()
  const resolvedApprovals = new Map<string, ApprovalResolvedEnvelope>()

  const send = (type: string, payload: Record<string, unknown>) =>
    deps.gateway.broadcast(JSON.stringify({ v: 1, type, ...payload }))
  const sendToPeer = (peer: WebSocketPeer, type: string, payload: Record<string, unknown>) =>
    peer.send(JSON.stringify({ v: 1, type, ...payload }))
  const sendError = (peer: WebSocketPeer, code: string) => {
    peer.send(JSON.stringify({ v: 1, type: 'error', code }))
  }
  const receive = async (peer: WebSocketPeer, raw: string) => {
    let message: ClientEnvelope
    try {
      message = JSON.parse(raw) as ClientEnvelope
    } catch {
      sendError(peer, 'invalid_json')
      return
    }
    if (message.v !== 1 || typeof message.type !== 'string') {
      sendError(peer, 'invalid_envelope')
      return
    }
    if (message.type === 'message') {
      if (typeof message.text !== 'string') {
        sendError(peer, 'invalid_message')
        return
      }
      if (message.text.length > MAX_TEXT_CHARS) {
        sendError(peer, 'message_too_large')
        return
      }
      const uploadIds = message.uploadIds === undefined ? [] : message.uploadIds
      if (
        !Array.isArray(uploadIds) ||
        uploadIds.some(item => !isIdentifier(item)) ||
        new Set(uploadIds).size !== uploadIds.length
      ) {
        sendError(peer, 'invalid_upload_ids')
        return
      }
      if (uploadIds.length > MAX_UPLOAD_IDS) {
        sendError(peer, 'too_many_uploads')
        return
      }
      if (message.clientMessageId !== undefined && !isIdentifier(message.clientMessageId)) {
        sendError(peer, 'invalid_client_message_id')
        return
      }
      if (!message.text.trim() && uploadIds.length === 0) {
        sendError(peer, 'invalid_message')
        return
      }
      const text = message.text.trim()
      if (text.toLowerCase() === '/help' && uploadIds.length === 0) {
        const language = (await deps.resolveUserLanguage?.('web', deps.userId)) ?? 'zh'
        peer.send(JSON.stringify({ v: 1, type: 'output', content: getHelpText(language), final: true }))
        return
      }
      let attachments: InboundAttachment[] = []
      try {
        attachments = uploadIds.length ? ((await deps.resolveUploads?.(uploadIds)) ?? []) : []
      } catch {
        sendError(peer, 'upload_unavailable')
        return
      }
      const prepared = deps.mediaPreprocessor
        ? await deps.mediaPreprocessor.preprocess({ text, attachments })
        : { text, warnings: [] }
      const target = await deps.resolveUserTarget?.('web', deps.userId)
      deps.bus.emit('MessageReceived', {
        userId: deps.userId,
        platform: 'web',
        cli: target?.cli ?? cli,
        cwd: target?.cwd ?? cwd,
        text,
        ...(prepared.text === text ? {} : { promptText: prepared.text }),
        attachments,
        ref: {
          platform: 'web',
          chatId: deps.userId,
          nativeId:
            typeof message.clientMessageId === 'string' && message.clientMessageId.trim()
              ? message.clientMessageId
              : crypto.randomUUID(),
        },
      })
      return
    }
    if (
      (message.type === 'approve' || message.type === 'reject') &&
      isIdentifier(message.approvalId) &&
      isIdentifier(message.conversationId)
    ) {
      const conversationId = message.conversationId as ConversationId
      if (!conversations.has(conversationId)) {
        sendError(peer, 'conversation_unavailable')
        return
      }
      const resolved = resolvedApprovals.get(approvalKey(conversationId, message.approvalId))
      if (resolved) {
        sendToPeer(peer, 'approval_resolved', { ...resolved, alreadyHandled: true })
        return
      }
      const payload = {
        conversationId,
        approvalId: message.approvalId,
        operator: deps.userId,
      }
      deps.bus.emit(message.type === 'approve' ? 'ApprovalApproved' : 'ApprovalRejected', payload)
      return
    }
    sendError(peer, 'invalid_message')
  }

  return {
    platform: 'web',
    async start() {
      deps.gateway.setReceiver((peer, data) => {
        void receive(peer, data)
      })
      const rememberConversation = (event: { platform: string; userId: string; conversationId: ConversationId }) => {
        if (event.platform === 'web' && event.userId === deps.userId) conversations.add(event.conversationId)
      }
      unsubs.push(deps.bus.on('SessionCreated', rememberConversation))
      unsubs.push(deps.bus.on('SessionMapped', rememberConversation))
      unsubs.push(
        deps.bus.on('MessageGenerated', event => {
          if (conversations.has(event.conversationId)) send('output', event)
        }),
      )
      unsubs.push(
        deps.bus.on('MessagePersisted', event => {
          if (event.ref.platform !== 'web' || event.ref.chatId !== deps.userId) return
          send('user_message', { clientMessageId: event.ref.nativeId, message: event.message })
        }),
      )
      unsubs.push(
        deps.bus.on('CommandReply', event => {
          if (event.ref.platform !== 'web' || event.ref.chatId !== deps.userId) return
          send('output', { content: event.content, final: true, attachments: event.attachments })
        }),
      )
      unsubs.push(
        deps.bus.on('ApprovalRequested', event => {
          if (conversations.has(event.conversationId)) send('approval', event)
        }),
      )
      unsubs.push(
        deps.bus.on('ApprovalApproved', event => {
          if (!conversations.has(event.conversationId)) return
          const resolved: ApprovalResolvedEnvelope = {
            conversationId: event.conversationId,
            approvalId: event.approvalId,
            status: 'approved',
            operator: event.operator,
            automatic: event.automatic === true,
          }
          resolvedApprovals.set(approvalKey(event.conversationId, event.approvalId), resolved)
          send('approval_resolved', { ...resolved })
        }),
      )
      unsubs.push(
        deps.bus.on('ApprovalRejected', event => {
          if (!conversations.has(event.conversationId)) return
          const resolved: ApprovalResolvedEnvelope = {
            conversationId: event.conversationId,
            approvalId: event.approvalId,
            status: 'rejected',
            operator: event.operator,
            automatic: false,
          }
          resolvedApprovals.set(approvalKey(event.conversationId, event.approvalId), resolved)
          send('approval_resolved', { ...resolved })
        }),
      )
      unsubs.push(
        deps.bus.on('ErrorOccurred', event => {
          if (!event.conversationId || conversations.has(event.conversationId))
            send('error', { code: 'server_error', message: event.message })
        }),
      )
      unsubs.push(
        deps.bus.on('ConversationDeleted', event => {
          conversations.delete(event.conversationId)
          for (const key of [...resolvedApprovals.keys()]) {
            if (key.startsWith(`${event.conversationId}:`)) resolvedApprovals.delete(key)
          }
          send('conversation_deleted', { conversationId: event.conversationId })
        }),
      )
    },
    async stop() {
      for (const unsub of unsubs.splice(0)) unsub()
      resolvedApprovals.clear()
    },
    async sendMessage(chatId, content) {
      if (send('output', { content, final: true }) === 0) throw new Error('No WebSocket client connected')
      return { platform: 'web', chatId, nativeId: crypto.randomUUID() }
    },
    async sendConversationMessage(conversationId, content) {
      if (!conversations.has(conversationId)) return null
      if (send('output', { conversationId, content, final: true }) === 0)
        throw new Error('No WebSocket client connected')
      return { platform: 'web', chatId: deps.userId, nativeId: crypto.randomUUID() }
    },
    async editMessage(ref, content) {
      send('edit', { ref, content })
    },
    async deleteMessage(ref) {
      send('delete', { ref })
    },
    async sendApproval(chatId, card: ApprovalCard) {
      send('approval', { chatId, ...card })
      return { platform: 'web', chatId, nativeId: card.approvalId }
    },
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_IDENTIFIER_CHARS
}

function approvalKey(conversationId: ConversationId, approvalId: string): string {
  return `${conversationId}:${approvalId}`
}
