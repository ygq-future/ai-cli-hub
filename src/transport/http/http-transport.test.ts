import { describe, expect, test } from 'bun:test'
import { createHttpRequestHandler, createHttpTransport } from './http-transport'
import type { ConversationId, MessageRef, Transport } from '../../shared'

const CID = 'conversation-1' as ConversationId

function createFakeTransport() {
  const sent: Array<{ mode: string; target: string; content: string }> = []
  const ref: MessageRef = { platform: 'telegram', chatId: 'chat-1', nativeId: 'message-1' }
  const transport: Transport = {
    platform: 'telegram',
    async start() {},
    async stop() {},
    async sendMessage(chatId, content) {
      sent.push({ mode: 'chat', target: chatId, content })
      return ref
    },
    async sendConversationMessage(conversationId, content) {
      sent.push({ mode: 'conversation', target: conversationId, content })
      return ref
    },
    async editMessage() {},
    async deleteMessage() {},
    async sendApproval() {
      return ref
    },
  }
  return { transport, sent }
}

function request(path: string, body: unknown, headers?: Record<string, string>) {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('HTTP transport', () => {
  test('允许绑定到 0.0.0.0', async () => {
    const fake = createFakeTransport()
    const transport = createHttpTransport({
      host: '0.0.0.0',
      port: 0,
      authToken: '',
      whitelistUserIds: [],
      transports: [fake.transport],
      resolveConversation: async () => null,
    })

    await transport.start()
    await transport.stop()
  })

  test('platform-msg 按 platform + chatId 发送', async () => {
    const fake = createFakeTransport()
    const handler = createHttpRequestHandler({
      host: '127.0.0.1',
      port: 8787,
      authToken: '',
      whitelistUserIds: ['chat-1'],
      transports: [fake.transport],
      resolveConversation: async () => null,
    })

    const response = await handler(
      request('/api/platform-msg', { platform: 'telegram', chatId: 'chat-1', content: 'hello' }),
    )

    expect(response.status).toBe(200)
    expect(fake.sent).toEqual([{ mode: 'chat', target: 'chat-1', content: 'hello' }])
  })

  test('session-msg 按 conversationId 发送', async () => {
    const fake = createFakeTransport()
    const handler = createHttpRequestHandler({
      host: '127.0.0.1',
      port: 8787,
      authToken: '',
      whitelistUserIds: [],
      transports: [fake.transport],
      resolveConversation: async conversationId => (conversationId === CID ? { transport: fake.transport } : null),
    })

    const response = await handler(request('/api/session-msg', { conversationId: CID, content: 'hello session' }))

    expect(response.status).toBe(200)
    expect(fake.sent).toEqual([{ mode: 'conversation', target: CID, content: 'hello session' }])
  })

  test('配置 token 时拒绝未授权请求', async () => {
    const handler = createHttpRequestHandler({
      host: '127.0.0.1',
      port: 8787,
      authToken: 'secret',
      whitelistUserIds: ['chat-1'],
      transports: [],
      resolveConversation: async () => null,
    })

    const response = await handler(
      request('/api/platform-msg', { platform: 'telegram', chatId: 'chat-1', content: 'hello' }),
    )

    expect(response.status).toBe(401)
  })
})
