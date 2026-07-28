import type { EventBus } from '../../event'
import type { ApprovalCard, CliType, ConversationId, Transport, Unsubscribe } from '../../shared'

export interface WebSocketPeer {
  send(data: string): void
  close(): void
}

export interface WebSocketGateway {
  setReceiver(receiver: (peer: WebSocketPeer, data: string) => void): void
  broadcast(data: string): void
  add(peer: WebSocketPeer): void
  remove(peer: WebSocketPeer): void
  receive(peer: WebSocketPeer, data: string): void
}

export interface WebSocketTransportDeps {
  bus: EventBus
  gateway: WebSocketGateway
  userId: string
  cli?: CliType
  cwd?: string
}

interface ClientEnvelope {
  v?: unknown
  type?: unknown
  text?: unknown
  approvalId?: unknown
  conversationId?: unknown
}

export function createWebSocketTransport(deps: WebSocketTransportDeps): Transport {
  const cli = deps.cli ?? 'claude'
  const cwd = deps.cwd ?? '/'
  const unsubs: Unsubscribe[] = []
  const conversations = new Set<ConversationId>()

  const send = (type: string, payload: Record<string, unknown>) =>
    deps.gateway.broadcast(JSON.stringify({ v: 1, type, ...payload }))
  const receive = (peer: WebSocketPeer, raw: string) => {
    let message: ClientEnvelope
    try {
      message = JSON.parse(raw) as ClientEnvelope
    } catch {
      peer.send(JSON.stringify({ v: 1, type: 'error', code: 'invalid_json' }))
      return
    }
    if (message.v !== 1 || typeof message.type !== 'string') {
      peer.send(JSON.stringify({ v: 1, type: 'error', code: 'invalid_envelope' }))
      return
    }
    if (message.type === 'message' && typeof message.text === 'string' && message.text.trim()) {
      deps.bus.emit('MessageReceived', {
        userId: deps.userId,
        platform: 'websocket',
        cli,
        cwd,
        text: message.text.trim(),
        ref: { platform: 'websocket', chatId: deps.userId, nativeId: crypto.randomUUID() },
      })
      return
    }
    if (
      (message.type === 'approve' || message.type === 'reject') &&
      typeof message.approvalId === 'string' &&
      typeof message.conversationId === 'string'
    ) {
      const payload = {
        conversationId: message.conversationId as ConversationId,
        approvalId: message.approvalId,
        operator: deps.userId,
      }
      deps.bus.emit(message.type === 'approve' ? 'ApprovalApproved' : 'ApprovalRejected', payload)
      return
    }
    peer.send(JSON.stringify({ v: 1, type: 'error', code: 'invalid_message' }))
  }

  return {
    platform: 'websocket',
    async start() {
      deps.gateway.setReceiver(receive)
      const rememberConversation = (event: { platform: string; userId: string; conversationId: ConversationId }) => {
        if (event.platform === 'websocket' && event.userId === deps.userId) conversations.add(event.conversationId)
      }
      unsubs.push(deps.bus.on('SessionCreated', rememberConversation))
      unsubs.push(deps.bus.on('SessionMapped', rememberConversation))
      unsubs.push(
        deps.bus.on('MessageGenerated', event => {
          if (conversations.has(event.conversationId)) send('output', event)
        }),
      )
      unsubs.push(
        deps.bus.on('ApprovalRequested', event => {
          if (conversations.has(event.conversationId)) send('approval', event)
        }),
      )
      unsubs.push(
        deps.bus.on('ErrorOccurred', event => {
          if (!event.conversationId || conversations.has(event.conversationId))
            send('error', { code: 'server_error', message: event.message })
        }),
      )
    },
    async stop() {
      for (const unsub of unsubs.splice(0)) unsub()
    },
    async sendMessage(chatId, content) {
      send('message', { chatId, content })
      return { platform: 'websocket', chatId, nativeId: crypto.randomUUID() }
    },
    async sendConversationMessage(conversationId, content) {
      if (!conversations.has(conversationId)) return null
      send('message', { conversationId, content })
      return { platform: 'websocket', chatId: deps.userId, nativeId: crypto.randomUUID() }
    },
    async editMessage(ref, content) {
      send('edit', { ref, content })
    },
    async deleteMessage(ref) {
      send('delete', { ref })
    },
    async sendApproval(chatId, card: ApprovalCard) {
      send('approval', { chatId, ...card })
      return { platform: 'websocket', chatId, nativeId: card.approvalId }
    },
  }
}
