import type { ConversationId, Platform, Transport } from '../shared'

const MAX_REQUEST_BYTES = 1_048_576
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const SUPPORTED_BIND_HOSTS = new Set(['0.0.0.0', '127.0.0.1', 'localhost', '::1'])

interface WebSocketPeer {
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

export interface HttpConversationTarget {
  transport: Transport
}

export interface AppServerDeps {
  host: string
  port: number
  authToken: string
  whitelistUserIds: readonly string[]
  transports: readonly Transport[]
  resolveConversation: (conversationId: ConversationId) => Promise<HttpConversationTarget | null>
  staticAssetsRoot?: string
  staticIndexPath?: string
  secureCookie?: boolean
  now?: () => number
  webSocketGateway?: WebSocketGateway
}

export interface AppServer {
  start(): Promise<void>
  stop(): Promise<void>
}

export type ServerRequestHandler = (
  request: Request,
  upgradeWebSocket?: (request: Request) => boolean,
) => Promise<Response>

interface MessageRequest {
  platform?: unknown
  chatId?: unknown
  conversationId?: unknown
  content?: unknown
}

export function createServer(deps: AppServerDeps): AppServer {
  let server: ReturnType<typeof Bun.serve> | null = null
  const websocketGateway = deps.webSocketGateway

  return {
    async start() {
      if (!SUPPORTED_BIND_HOSTS.has(deps.host)) {
        throw new Error(`HTTP server host must be one of 0.0.0.0, 127.0.0.1, localhost, or ::1; received: ${deps.host}`)
      }
      if (server) return
      const handler = createServerRequestHandler(deps)
      server = Bun.serve({
        hostname: deps.host,
        port: deps.port,
        fetch: (request, bunServer) =>
          handler(request, upgradeRequest => bunServer.upgrade(upgradeRequest, { data: {} })),
        websocket: {
          open(ws) {
            websocketGateway?.add(ws as unknown as WebSocketPeer)
          },
          message(ws, message) {
            websocketGateway?.receive(ws as unknown as WebSocketPeer, String(message))
          },
          close(ws) {
            websocketGateway?.remove(ws as unknown as WebSocketPeer)
          },
        },
      })
    },
    async stop() {
      const active = server
      server = null
      active?.stop(true)
    },
  }
}

export function createWebSocketGateway(): WebSocketGateway {
  const peers = new Set<WebSocketPeer>()
  let receiver: ((peer: WebSocketPeer, data: string) => void) | null = null
  return {
    setReceiver(next) {
      receiver = next
    },
    broadcast(data) {
      for (const peer of peers) peer.send(data)
    },
    add(peer: WebSocketPeer) {
      peers.add(peer)
    },
    remove(peer: WebSocketPeer) {
      peers.delete(peer)
    },
    receive(peer: WebSocketPeer, data: string) {
      receiver?.(peer, data)
    },
  }
}

export function createServerRequestHandler(deps: AppServerDeps): ServerRequestHandler {
  const sessions = new Map<string, number>()
  const now = deps.now ?? Date.now

  return async function handle(request: Request, upgradeWebSocket?: (request: Request) => boolean): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') return json({ status: 'ok' })
    if (url.pathname === '/api/auth/session') return handleSessionRequest(request, deps, sessions, now)
    if (url.pathname === '/ws') {
      if (!isAuthorized(request, deps.authToken, sessions, now())) return json({ error: 'Unauthorized' }, 401)
      if (upgradeWebSocket?.(request)) return undefined as unknown as Response
      return json({ error: 'WebSocket transport is not configured' }, 501)
    }

    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'POST' || (url.pathname !== '/api/platform-msg' && url.pathname !== '/api/session-msg')) {
        return json({ error: 'Not found' }, 404)
      }
      if (!isAuthorized(request, deps.authToken, sessions, now())) return json({ error: 'Unauthorized' }, 401)
      return handleMessageRequest(request, url.pathname, deps)
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Not found' }, 404)
    return serveWebUi(url.pathname, request.method, deps)
  }
}

async function handleSessionRequest(
  request: Request,
  deps: AppServerDeps,
  sessions: Map<string, number>,
  now: () => number,
): Promise<Response> {
  if (!deps.authToken)
    return json({ error: 'Web authentication is unavailable until http.authToken is configured' }, 503)

  if (request.method === 'GET') {
    if (!isAuthorized(request, deps.authToken, sessions, now())) return json({ authenticated: false }, 401)
    return json({ authenticated: true })
  }
  if (request.method === 'POST') {
    if (!hasBearerToken(request, deps.authToken)) return json({ error: 'Unauthorized' }, 401)
    const sessionId = crypto.randomUUID()
    sessions.set(sessionId, now() + SESSION_TTL_MS)
    return json({ authenticated: true }, 200, {
      'set-cookie': createSessionCookie(sessionId, deps.secureCookie === true),
    })
  }
  if (request.method === 'DELETE') {
    const sessionId = readCookie(request.headers.get('cookie'), 'ai_cli_hub_session')
    if (sessionId) sessions.delete(sessionId)
    return json({ authenticated: false }, 200, { 'set-cookie': clearSessionCookie(deps.secureCookie === true) })
  }
  return json({ error: 'Method not allowed' }, 405, { allow: 'GET, POST, DELETE' })
}

async function handleMessageRequest(request: Request, pathname: string, deps: AppServerDeps): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) return json({ error: 'Request body is too large' }, 413)

  let body: MessageRequest
  try {
    const raw = await request.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES)
      return json({ error: 'Request body is too large' }, 413)
    body = JSON.parse(raw) as MessageRequest
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400)
  }

  const content = asNonEmptyString(body.content)
  if (!content) return json({ error: 'content must be a non-empty string' }, 400)

  try {
    if (pathname === '/api/session-msg') {
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

async function serveWebUi(pathname: string, method: string, deps: AppServerDeps): Promise<Response> {
  const assetPath = toAssetPath(pathname, deps.staticAssetsRoot ?? 'public/webui')
  if (pathname.startsWith('/webui/assets/') && !assetPath) return json({ error: 'Not found' }, 404)
  const file = Bun.file(assetPath ?? deps.staticIndexPath ?? 'src/webui/index.html')
  if (!(await file.exists())) return json({ error: 'Not found' }, 404)
  return new Response(method === 'HEAD' ? null : file, {
    headers: { 'content-type': contentType(assetPath ?? 'index.html') },
  })
}

function toAssetPath(pathname: string, root: string): string | null {
  if (!pathname.startsWith('/webui/assets/')) return null
  const relativePath = pathname.slice('/webui/assets/'.length)
  if (!relativePath || relativePath.includes('..') || relativePath.includes('\\')) return null
  return `${root}/assets/${relativePath}`
}

function contentType(pathname: string): string {
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8'
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (pathname.endsWith('.svg')) return 'image/svg+xml'
  if (pathname.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'text/html; charset=utf-8'
}

function parsePlatform(value: unknown): Platform | null {
  return value === 'telegram' || value === 'qq' || value === 'websocket' ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isAuthorized(request: Request, authToken: string, sessions: Map<string, number>, now: number): boolean {
  if (!authToken || hasBearerToken(request, authToken)) return true
  const sessionId = readCookie(request.headers.get('cookie'), 'ai_cli_hub_session')
  if (!sessionId) return false
  const expiresAt = sessions.get(sessionId)
  if (!expiresAt || expiresAt <= now) {
    sessions.delete(sessionId)
    return false
  }
  return true
}

function hasBearerToken(request: Request, authToken: string): boolean {
  return request.headers.get('authorization') === `Bearer ${authToken}`
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null
  const prefix = `${name}=`
  const item = cookieHeader
    .split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(prefix))
  return item ? decodeURIComponent(item.slice(prefix.length)) : null
}

function createSessionCookie(sessionId: string, secure: boolean): string {
  return `ai_cli_hub_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`
}

function clearSessionCookie(secure: boolean): string {
  return `ai_cli_hub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`
}

function json(body: Record<string, unknown>, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers })
}
