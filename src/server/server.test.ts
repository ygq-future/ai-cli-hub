import { describe, expect, test } from 'bun:test'
import { createServer, createServerRequestHandler } from './server'
import type { ConversationId, MessageRef, Transport } from '../shared'

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

function createHandler(authToken = '') {
  const fake = createFakeTransport()
  const handler = createServerRequestHandler({
    host: '127.0.0.1',
    port: 8787,
    authToken,
    whitelistUserIds: ['chat-1'],
    transports: [fake.transport],
    resolveConversation: async conversationId => (conversationId === CID ? { transport: fake.transport } : null),
  })
  return { handler, fake }
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://127.0.0.1${path}`, init)
}

function messageRequest(path: string, body: unknown, headers?: Record<string, string>) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('app server', () => {
  test('允许绑定到 0.0.0.0', async () => {
    const fake = createFakeTransport()
    const server = createServer({
      host: '0.0.0.0',
      port: 0,
      authToken: '',
      whitelistUserIds: [],
      transports: [fake.transport],
      resolveConversation: async () => null,
    })
    await server.start()
    await server.stop()
  })

  test('platform-msg 按 platform + chatId 发送', async () => {
    const { handler, fake } = createHandler()
    const response = await handler(
      messageRequest('/api/platform-msg', { platform: 'telegram', chatId: 'chat-1', content: 'hello' }),
    )
    expect(response.status).toBe(200)
    expect(fake.sent).toEqual([{ mode: 'chat', target: 'chat-1', content: 'hello' }])
  })

  test('session-msg 按 conversationId 发送', async () => {
    const { handler, fake } = createHandler()
    const response = await handler(
      messageRequest('/api/session-msg', { conversationId: CID, content: 'hello session' }),
    )
    expect(response.status).toBe(200)
    expect(fake.sent).toEqual([{ mode: 'conversation', target: CID, content: 'hello session' }])
  })

  test('配置 token 时拒绝未授权兼容请求', async () => {
    const { handler } = createHandler('secret')
    const response = await handler(
      messageRequest('/api/platform-msg', { platform: 'telegram', chatId: 'chat-1', content: 'hello' }),
    )
    expect(response.status).toBe(401)
  })

  test('WebSocket 端点在 W2 前拒绝未认证请求，认证后明确尚未配置', async () => {
    const { handler } = createHandler('secret')
    expect((await handler(request('/ws'))).status).toBe(401)
    expect((await handler(request('/ws', { headers: { authorization: 'Bearer secret' } }))).status).toBe(501)
  })

  test('Bearer 登录建立 HttpOnly 会话，Cookie 可访问兼容接口', async () => {
    const { handler, fake } = createHandler('secret')
    const login = await handler(
      request('/api/auth/session', { method: 'POST', headers: { authorization: 'Bearer secret' } }),
    )
    const cookie = login.headers.get('set-cookie')

    expect(login.status).toBe(200)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')

    const response = await handler(
      messageRequest(
        '/api/platform-msg',
        { platform: 'telegram', chatId: 'chat-1', content: 'through session' },
        { cookie: cookie ?? '' },
      ),
    )
    expect(response.status).toBe(200)
    expect(fake.sent).toEqual([{ mode: 'chat', target: 'chat-1', content: 'through session' }])
  })

  test('WebUI 静态入口可用，SPA 路由回退到入口', async () => {
    const { handler } = createHandler('secret')
    const response = await handler(request('/settings'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('<hub-console>')
  })

  test('不存在或非法的静态资源不回退到入口', async () => {
    const { handler } = createHandler('secret')
    expect((await handler(request('/webui/assets/missing.js'))).status).toBe(404)
    expect((await handler(request('/webui/assets/..%2Findex.html'))).status).toBe(404)
  })

  test('未配置 Token 时 Web 登录不可用，保持旧 HTTP 接口兼容', async () => {
    const { handler } = createHandler()
    expect((await handler(request('/api/auth/session', { method: 'POST' }))).status).toBe(503)
    expect(
      (
        await handler(
          messageRequest('/api/platform-msg', { platform: 'telegram', chatId: 'chat-1', content: 'legacy' }),
        )
      ).status,
    ).toBe(200)
  })
})
