import { describe, expect, test } from 'bun:test'
import { createServer, createServerRequestHandler, createWebSocketGateway, type AppServerDeps } from './server'
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

function createHandler(authToken = '', now?: () => number, overrides: Partial<AppServerDeps> = {}) {
  const fake = createFakeTransport()
  const handler = createServerRequestHandler({
    host: '127.0.0.1',
    port: 8787,
    authToken,
    whitelistUserIds: ['chat-1'],
    transports: [fake.transport],
    resolveConversation: async conversationId => (conversationId === CID ? { transport: fake.transport } : null),
    staticIndexPath: 'src/webui/index.html',
    now,
    ...overrides,
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
    const { handler, fake } = createHandler('secret')
    const response = await handler(
      messageRequest(
        '/api/platform-msg',
        { platform: 'telegram', chatId: 'chat-1', content: 'hello' },
        { authorization: 'Bearer secret' },
      ),
    )
    expect(response.status).toBe(200)
    expect(fake.sent).toEqual([{ mode: 'chat', target: 'chat-1', content: 'hello' }])
  })

  test('platform-msg 兼容 content 字符串中的未转义换行和控制字符', async () => {
    const { handler, fake } = createHandler('secret')
    const multiline = '<#> 验证码: 370-594\n请不要与其他人共享\t此密码'
    const malformedJson = `{
      "platform": "telegram",
      "chatId": "chat-1",
      "content": "${multiline}"
    }`
    const response = await handler(
      request('/api/platform-msg', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: malformedJson,
      }),
    )

    expect(response.status).toBe(200)
    expect(fake.sent).toEqual([{ mode: 'chat', target: 'chat-1', content: multiline }])
  })

  test('消息接口不会把结构错误的 JSON 静默修复', async () => {
    const { handler } = createHandler('secret')
    const response = await handler(
      request('/api/platform-msg', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: '{"platform":"telegram","chatId":"chat-1","content":"hello",}',
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Request body must be valid JSON' })
  })

  test('session-msg 按 conversationId 发送', async () => {
    const { handler, fake } = createHandler('secret')
    const response = await handler(
      messageRequest(
        '/api/session-msg',
        { conversationId: CID, content: 'hello session' },
        { authorization: 'Bearer secret' },
      ),
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

  test('未配置 token 时拒绝兼容消息请求', async () => {
    const { handler } = createHandler()
    const response = await handler(
      messageRequest('/api/platform-msg', { platform: 'telegram', chatId: 'chat-1', content: 'hello' }),
    )
    expect(response.status).toBe(401)
  })

  test('health 区分 live 与 ready，并保留 /health readiness 兼容入口', async () => {
    const down = createHandler('secret', undefined, {
      health: {
        ready: async () => ({
          status: 'down',
          uptimeMs: 123,
          checks: [{ name: 'database', status: 'down', detail: 'unavailable', critical: true }],
        }),
      },
    })

    expect((await down.handler(request('/health/live'))).status).toBe(200)
    for (const path of ['/health', '/health/ready']) {
      const response = await down.handler(request(path))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        status: 'down',
        uptimeMs: 123,
        checks: [{ name: 'database', status: 'down', detail: 'unavailable', critical: true }],
      })
    }

    const degraded = createHandler('secret', undefined, {
      health: {
        ready: async () => ({
          status: 'degraded',
          uptimeMs: 456,
          checks: [{ name: 'cli.opencode', status: 'down', detail: 'not installed' }],
        }),
      },
    })
    expect((await degraded.handler(request('/health/ready'))).status).toBe(200)
  })

  test('上传在解析 multipart 前拒绝超过服务上限的请求体', async () => {
    const { handler } = createHandler('secret', undefined, {
      maxRequestBodyBytes: 1024,
      uploads: { stage: async () => ({ id: 'upload-1', name: 'x', mimeType: 'text/plain', size: 1 }) },
    })
    const response = await handler(
      request('/api/web/uploads', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-length': '1025' },
        body: 'x',
      }),
    )
    expect(response.status).toBe(413)
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

  test('Web 会话 Cookie 跨重启有效、访问时续期，并在到期或 Token 改变后失效', async () => {
    let currentTime = 1_000
    const now = () => currentTime
    const first = createHandler('secret', now)
    const login = await first.handler(
      request('/api/auth/session', { method: 'POST', headers: { authorization: 'Bearer secret' } }),
    )
    const cookie = login.headers.get('set-cookie') ?? ''

    currentTime += 4 * 60 * 60 * 1000
    const restarted = createHandler('secret', now)
    const refreshed = await restarted.handler(request('/api/auth/session', { headers: { cookie } }))
    const refreshedCookie = refreshed.headers.get('set-cookie') ?? ''
    expect(refreshed.status).toBe(200)

    const changedToken = createHandler('new-secret', now)
    expect((await changedToken.handler(request('/api/auth/session', { headers: { cookie } }))).status).toBe(401)

    currentTime += 5 * 60 * 60 * 1000
    expect((await restarted.handler(request('/api/auth/session', { headers: { cookie } }))).status).toBe(401)
    expect(
      (await restarted.handler(request('/api/auth/session', { headers: { cookie: refreshedCookie } }))).status,
    ).toBe(200)
  })

  test('WebSocket gateway 等待客户端连接后再继续发送', async () => {
    const gateway = createWebSocketGateway()
    let connected = false
    const waiting = gateway.waitForPeer().then(() => {
      connected = true
    })
    await Promise.resolve()
    expect(connected).toBe(false)

    const sent: string[] = []
    gateway.add({ send: data => sent.push(data), close: () => undefined })
    await waiting

    expect(connected).toBe(true)
    expect(sent.map(data => JSON.parse(data))).toEqual([{ v: 1, type: 'connected' }])
  })

  test('WebUI 静态入口可用，SPA 路由回退到入口', async () => {
    const { handler } = createHandler('secret')
    const response = await handler(request('/settings'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('id="root"')
  })

  test('不存在或非法的静态资源不回退到入口', async () => {
    const { handler } = createHandler('secret')
    expect((await handler(request('/webui/assets/missing.js'))).status).toBe(404)
    expect((await handler(request('/webui/assets/..%2Findex.html'))).status).toBe(404)
  })

  test('WebUI 构建资源可从 assets 路径读取', async () => {
    const fake = createFakeTransport()
    const handler = createServerRequestHandler({
      host: '127.0.0.1',
      port: 8787,
      authToken: 'secret',
      whitelistUserIds: [],
      transports: [fake.transport],
      resolveConversation: async () => null,
      staticAssetsRoot: 'src/webui/public',
      staticIndexPath: 'src/webui/index.html',
    })
    const response = await handler(request('/webui/assets/icon.svg'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
  })

  test('模块脚本请求不回退到 SPA 入口', async () => {
    const { handler } = createHandler('secret')
    const response = await handler(request('/main.tsx'))
    expect(response.status).toBe(404)
  })

  test('未配置 Token 时 Web 登录不可用且 HTTP 消息接口拒绝请求', async () => {
    const { handler } = createHandler()
    expect((await handler(request('/api/auth/session', { method: 'POST' }))).status).toBe(503)
    expect(
      (
        await handler(
          messageRequest('/api/platform-msg', { platform: 'telegram', chatId: 'chat-1', content: 'legacy' }),
        )
      ).status,
    ).toBe(401)
  })

  test('配置 API 脱敏读取、校验保存与重启预览均需要认证', async () => {
    const fake = createFakeTransport()
    let saved: Record<string, unknown> | null = null
    const handler = createServerRequestHandler({
      host: '127.0.0.1',
      port: 8787,
      authToken: 'secret',
      whitelistUserIds: [],
      transports: [fake.transport],
      resolveConversation: async () => null,
      settings: {
        read: async () => ({ http: { authToken: { configured: true } } }),
        save: async value => {
          if (!value.http) throw new Error('invalid settings')
          saved = value
        },
      },
      restart: { preview: () => 'restart preview', run: async () => 'restart scheduled' },
    })
    expect((await handler(request('/api/settings'))).status).toBe(401)
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const read = await handler(request('/api/settings', { headers }))
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ settings: { http: { authToken: { configured: true } } } })
    expect((await handler(request('/api/settings', { method: 'PUT', headers, body: JSON.stringify({}) }))).status).toBe(
      400,
    )
    expect(saved).toBeNull()
    expect((await handler(request('/api/restart', { headers: { authorization: 'Bearer secret' } }))).status).toBe(200)
  })

  test('Web 状态 API 仅返回 web 当前会话的真实状态', async () => {
    const fake = createFakeTransport()
    const handler = createServerRequestHandler({
      host: '127.0.0.1',
      port: 8787,
      authToken: 'secret',
      whitelistUserIds: ['chat-1'],
      transports: [fake.transport],
      resolveConversation: async () => null,
      webStatus: {
        get: async () => ({
          platform: 'web',
          conversationId: 'web-conversation',
          cli: 'claude',
          cwd: '/workspace',
          sessionStatus: 'running',
          model: { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
          autoApprove: { enabled: true, seconds: 5 },
        }),
      },
    })
    const response = await handler(request('/api/web/status', { headers: { authorization: 'Bearer secret' } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: {
        platform: 'web',
        conversationId: 'web-conversation',
        cli: 'claude',
        cwd: '/workspace',
        sessionStatus: 'running',
        model: { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
        autoApprove: { enabled: true, seconds: 5 },
      },
    })
  })

  test('Web 历史 API 返回当前 Web 会话消息且需要认证', async () => {
    const fake = createFakeTransport()
    const historyInputs: Array<{ limit: number; before: string | null }> = []
    const handler = createServerRequestHandler({
      host: '127.0.0.1',
      port: 8787,
      authToken: 'secret',
      whitelistUserIds: ['chat-1'],
      transports: [fake.transport],
      resolveConversation: async () => null,
      webHistory: {
        get: async input => {
          historyInputs.push(input)
          return {
            messages: [
              { id: 'message-1', role: 'user', content: 'hello', createdAt: 1 },
              {
                id: 'message-2',
                role: 'assistant',
                content: '**world**',
                attachments: [
                  {
                    id: 'file-1',
                    kind: 'photo',
                    fileName: 'screen.png',
                    mimeType: 'image/png',
                    fileSize: 4,
                  },
                ],
                createdAt: 2,
              },
            ],
            nextCursor: input.limit === 10 && input.before === null ? '1:message-1' : null,
          }
        },
      },
    })

    expect((await handler(request('/api/web/history'))).status).toBe(401)
    const response = await handler(request('/api/web/history', { headers: { authorization: 'Bearer secret' } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      messages: [
        { id: 'message-1', role: 'user', content: 'hello', createdAt: 1 },
        {
          id: 'message-2',
          role: 'assistant',
          content: '**world**',
          attachments: [
            {
              id: 'file-1',
              kind: 'photo',
              fileName: 'screen.png',
              mimeType: 'image/png',
              fileSize: 4,
            },
          ],
          createdAt: 2,
        },
      ],
      nextCursor: '1:message-1',
    })
    expect(historyInputs).toEqual([{ limit: 10, before: null }])
    expect(
      (await handler(request('/api/web/history?limit=51', { headers: { authorization: 'Bearer secret' } }))).status,
    ).toBe(400)
  })

  test('Web 文件 API 只向已认证会话返回受控文件', async () => {
    const fake = createFakeTransport()
    const handler = createServerRequestHandler({
      host: '127.0.0.1',
      port: 8787,
      authToken: 'secret',
      whitelistUserIds: ['chat-1'],
      transports: [fake.transport],
      resolveConversation: async () => null,
      webFiles: {
        get: async id =>
          id === 'file-1' ? { body: new Blob(['image']), fileName: 'screen.png', mimeType: 'image/png' } : null,
      },
    })

    expect((await handler(request('/api/web/files/file-1'))).status).toBe(401)
    const response = await handler(request('/api/web/files/file-1', { headers: { authorization: 'Bearer secret' } }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-disposition')).toContain('screen.png')
    expect(await response.text()).toBe('image')
    expect(
      (await handler(request('/api/web/files/missing', { headers: { authorization: 'Bearer secret' } }))).status,
    ).toBe(404)
  })
})
