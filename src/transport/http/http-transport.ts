import type { ConversationId, Platform, Transport } from '../../shared'

const MAX_REQUEST_BYTES = 1_048_576
const SUPPORTED_BIND_HOSTS = new Set(['0.0.0.0', '127.0.0.1', 'localhost', '::1'])

export interface HttpConversationTarget {
  transport: Transport
}

export interface HttpTransportDeps {
  host: string
  port: number
  authToken: string
  whitelistUserIds: readonly string[]
  transports: readonly Transport[]
  resolveConversation: (conversationId: ConversationId) => Promise<HttpConversationTarget | null>
}

export interface HttpTransport {
  start(): Promise<void>
  stop(): Promise<void>
}

export type HttpRequestHandler = (request: Request) => Promise<Response>

interface MessageRequest {
  platform?: unknown
  chatId?: unknown
  conversationId?: unknown
  content?: unknown
}

export function createHttpTransport(deps: HttpTransportDeps): HttpTransport {
  let server: ReturnType<typeof Bun.serve> | null = null

  return {
    async start() {
      if (!SUPPORTED_BIND_HOSTS.has(deps.host)) {
        throw new Error(
          `HTTP transport host must be one of 0.0.0.0, 127.0.0.1, localhost, or ::1; received: ${deps.host}`,
        )
      }
      if (server) return
      server = Bun.serve({
        hostname: deps.host,
        port: deps.port,
        fetch: createHttpRequestHandler(deps),
      })
    },
    async stop() {
      const active = server
      server = null
      active?.stop(true)
    },
  }
}

export function createHttpRequestHandler(deps: HttpTransportDeps): HttpRequestHandler {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok' })
    }

    if (request.method !== 'POST' || (url.pathname !== '/api/platform-msg' && url.pathname !== '/api/session-msg')) {
      return json({ error: 'Not found' }, 404)
    }

    if (!isAuthorized(request, deps.authToken)) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const length = Number(request.headers.get('content-length') ?? 0)
    if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
      return json({ error: 'Request body is too large' }, 413)
    }

    let body: MessageRequest
    try {
      const raw = await request.text()
      if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
        return json({ error: 'Request body is too large' }, 413)
      }
      body = JSON.parse(raw) as MessageRequest
    } catch {
      return json({ error: 'Request body must be valid JSON' }, 400)
    }

    const content = asNonEmptyString(body.content)
    if (!content) return json({ error: 'content must be a non-empty string' }, 400)

    try {
      if (url.pathname === '/api/session-msg') {
        const conversationId = asNonEmptyString(body.conversationId)
        if (!conversationId) return json({ error: 'conversationId must be a non-empty string' }, 400)
        const target = await deps.resolveConversation(conversationId as ConversationId)
        if (!target) return json({ error: 'Conversation not found or unavailable' }, 404)
        const ref = await target.transport.sendConversationMessage(conversationId as ConversationId, content)
        if (!ref) return json({ error: 'Conversation has no active chat mapping' }, 503)
        return json({ delivered: true, mode: 'conversationId', ref })
      }

      const chatId = asNonEmptyString(body.chatId)
      if (!chatId) return json({ error: 'chatId must be a non-empty string' }, 400)
      const platform = parsePlatform(body.platform)
      if (!platform) return json({ error: 'platform must be telegram, qq, or websocket' }, 400)
      if (!deps.whitelistUserIds.includes(chatId)) return json({ error: 'chatId is not whitelisted' }, 403)
      const transport = deps.transports.find(item => item.platform === platform)
      if (!transport) return json({ error: `Transport is not enabled: ${platform}` }, 503)
      const ref = await transport.sendMessage(chatId, content)
      return json({ delivered: true, mode: 'chatId', ref })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }
}

function parsePlatform(value: unknown): Platform | null {
  return value === 'telegram' || value === 'qq' || value === 'websocket' ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isAuthorized(request: Request, authToken: string): boolean {
  if (!authToken) return true
  return request.headers.get('authorization') === `Bearer ${authToken}`
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status })
}
