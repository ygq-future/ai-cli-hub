import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ApprovalAuditRequest, ApprovalStatus, ConversationId, Platform, Transport } from '../shared'
import type { WebAdmin } from '../shared'

const MAX_REQUEST_BYTES = 1_048_576
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const SUPPORTED_BIND_HOSTS = new Set(['0.0.0.0', '127.0.0.1', 'localhost', '::1'])

interface WebSocketPeer {
  send(data: string): number | void
  close(code?: number, reason?: string): void
}

export interface WebSocketGateway {
  setReceiver(receiver: (peer: WebSocketPeer, data: string) => void): void
  broadcast(data: string): number
  waitForPeer(): Promise<void>
  add(peer: WebSocketPeer): boolean
  remove(peer: WebSocketPeer): void
  receive(peer: WebSocketPeer, data: string): void
}

export interface HttpConversationTarget {
  transport: Transport
}

export interface WebSessionStatus {
  platform: 'web'
  conversationId: string | null
  cli: string
  cwd: string
  sessionStatus: string
  model: { id: string; name: string } | null
  autoApprove: { enabled: boolean; seconds: number }
}

export interface WebHistoryChatMessage {
  type: 'chat'
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: Array<{
    id: string
    kind: string
    fileName: string | null
    mimeType: string | null
    fileSize: number | null
  }>
  createdAt: number
}

export interface WebHistoryApproval {
  id: string
  conversationId: string
  approvalId: string
  request: ApprovalAuditRequest
  status: ApprovalStatus
  operator: string | null
  automatic: boolean
  createdAt: number
}

export interface WebHistoryApprovalMessage {
  type: 'approval'
  id: string
  createdAt: number
  approval: WebHistoryApproval | null
}

export type WebHistoryMessage = WebHistoryChatMessage | WebHistoryApprovalMessage

export interface AppServerDeps {
  host: string
  port: number
  authToken: string
  maxRequestBodyBytes?: number
  whitelistUserIds: readonly string[]
  transports: readonly Transport[]
  resolveConversation: (conversationId: ConversationId) => Promise<HttpConversationTarget | null>
  staticAssetsRoot?: string
  staticIndexPath?: string
  secureCookie?: boolean
  now?: () => number
  webSocketGateway?: WebSocketGateway
  health?: {
    ready(): Promise<{
      status: 'ok' | 'degraded' | 'down'
      uptimeMs: number
      checks: Array<{ name: string; status: 'ok' | 'degraded' | 'down'; detail: string; critical?: boolean }>
    }>
  }
  settings?: { read(): Promise<Record<string, unknown>>; save(input: Record<string, unknown>): Promise<void> }
  restart?: { preview(): string; run(): Promise<string> }
  webStatus?: { get(): Promise<WebSessionStatus> }
  webHistory?: {
    get(input: { limit: number; before: string | null }): Promise<{
      messages: WebHistoryMessage[]
      nextCursor: string | null
    }>
  }
  webFiles?: {
    get(id: string): Promise<{ body: Blob; fileName: string | null; mimeType: string | null } | null>
  }
  uploads?: { stage(file: File): Promise<{ id: string; name: string; mimeType: string; size: number }> }
  webAdmin?: WebAdmin
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
        maxRequestBodySize: deps.maxRequestBodyBytes,
        fetch: (request, bunServer) =>
          handler(request, upgradeRequest => bunServer.upgrade(upgradeRequest, { data: {} })),
        websocket: {
          maxPayloadLength: 128 * 1024,
          backpressureLimit: 256 * 1024,
          closeOnBackpressureLimit: true,
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

export function createWebSocketGateway(options: { maxPeers?: number } = {}): WebSocketGateway {
  const maxPeers = Math.max(1, options.maxPeers ?? 5)
  const peers = new Set<WebSocketPeer>()
  const peerWaiters = new Set<() => void>()
  let receiver: ((peer: WebSocketPeer, data: string) => void) | null = null
  return {
    setReceiver(next) {
      receiver = next
    },
    broadcast(data) {
      let delivered = 0
      for (const peer of [...peers]) {
        try {
          const result = peer.send(data)
          if (result === 0) throw new Error('WebSocket message was not sent')
          delivered += 1
        } catch {
          peers.delete(peer)
          safeClose(peer, 1011, 'WebSocket send failed')
        }
      }
      return delivered
    },
    async waitForPeer() {
      if (peers.size) return
      await new Promise<void>(resolve => peerWaiters.add(resolve))
    },
    add(peer: WebSocketPeer) {
      if (peers.size >= maxPeers) {
        safeClose(peer, 1013, 'Too many WebSocket connections')
        return false
      }
      peers.add(peer)
      try {
        peer.send(JSON.stringify({ v: 1, type: 'connected' }))
      } catch {
        peers.delete(peer)
        safeClose(peer, 1011, 'WebSocket initialization failed')
        return false
      }
      for (const resolve of peerWaiters) resolve()
      peerWaiters.clear()
      return true
    },
    remove(peer: WebSocketPeer) {
      peers.delete(peer)
    },
    receive(peer: WebSocketPeer, data: string) {
      receiver?.(peer, data)
    },
  }
}

function safeClose(peer: WebSocketPeer, code: number, reason: string): void {
  try {
    peer.close(code, reason)
  } catch {
    // The peer is already unusable; removing it from the gateway is sufficient.
  }
}

export function createServerRequestHandler(deps: AppServerDeps): ServerRequestHandler {
  const now = deps.now ?? Date.now

  return async function handle(request: Request, upgradeWebSocket?: (request: Request) => boolean): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health/live') return json({ status: 'ok' })
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/health/ready')) {
      if (!deps.health) return json({ status: 'down', error: 'Health readiness is not configured' }, 503)
      try {
        const snapshot = await deps.health.ready()
        return json({ ...snapshot }, snapshot.status === 'down' ? 503 : 200)
      } catch {
        return json({ status: 'down', error: 'Health readiness check failed' }, 503)
      }
    }
    if (url.pathname === '/api/auth/session') return handleSessionRequest(request, deps, now)
    if (url.pathname === '/ws') {
      if (!isAuthorized(request, deps.authToken, now())) return json({ error: 'Unauthorized' }, 401)
      if (!isAllowedWebSocketOrigin(request)) return json({ error: 'Forbidden WebSocket origin' }, 403)
      if (upgradeWebSocket?.(request)) return undefined as unknown as Response
      return json({ error: 'WebSocket transport is not configured' }, 501)
    }

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/web/status') return handleWebStatusRequest(request, deps, now())
      if (url.pathname === '/api/web/history') return handleWebHistoryRequest(request, url, deps, now())
      if (url.pathname.startsWith('/api/web/files/')) return handleWebFileRequest(request, url.pathname, deps, now())
      if (url.pathname === '/api/web/uploads') return handleUploadRequest(request, deps, now())
      if (url.pathname === '/api/settings') return handleSettingsRequest(request, deps, now())
      if (url.pathname === '/api/restart') return handleRestartRequest(request, deps, now())
      if (request.method !== 'POST' || (url.pathname !== '/api/platform-msg' && url.pathname !== '/api/session-msg')) {
        return json({ error: 'Not found' }, 404)
      }
      if (!isAuthorized(request, deps.authToken, now())) return json({ error: 'Unauthorized' }, 401)
      return handleMessageRequest(request, url.pathname, deps)
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Not found' }, 404)
    if (!url.pathname.startsWith('/webui/assets/') && looksLikeFileRequest(url.pathname)) {
      return json({ error: 'Not found' }, 404)
    }
    return serveWebUi(url.pathname, request.method, deps)
  }
}

async function handleWebFileRequest(
  request: Request,
  pathname: string,
  deps: AppServerDeps,
  now: number,
): Promise<Response> {
  if (!isAuthorized(request, deps.authToken, now)) return json({ error: 'Unauthorized' }, 401)
  if (!deps.webFiles) return json({ error: 'Web file API is not configured' }, 501)
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return json({ error: 'Method not allowed' }, 405, { allow: 'GET, HEAD' })
  let id: string
  try {
    id = decodeURIComponent(pathname.slice('/api/web/files/'.length))
  } catch {
    return json({ error: 'Not found' }, 404)
  }
  if (!id || id.includes('/') || id.includes('\\')) return json({ error: 'Not found' }, 404)
  const file = await deps.webFiles.get(id)
  if (!file) return json({ error: 'Not found' }, 404)
  const headers = new Headers({ 'content-type': file.mimeType ?? 'application/octet-stream' })
  if (file.fileName) headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
  return new Response(request.method === 'HEAD' ? null : file.body, { headers })
}

async function handleWebHistoryRequest(
  request: Request,
  url: URL,
  deps: AppServerDeps,
  now: number,
): Promise<Response> {
  if (!isAuthorized(request, deps.authToken, now)) return json({ error: 'Unauthorized' }, 401)
  if (!deps.webHistory) return json({ error: 'Web history is not configured' }, 501)
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { allow: 'GET' })
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? 10 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return json({ error: 'limit must be between 1 and 50' }, 400)
  const before = url.searchParams.get('before')
  if (before !== null && !/^\d+:[A-Za-z0-9_-]+$/.test(before)) return json({ error: 'Invalid history cursor' }, 400)
  return json(await deps.webHistory.get({ limit, before }))
}

async function handleUploadRequest(request: Request, deps: AppServerDeps, now: number): Promise<Response> {
  if (!isAuthorized(request, deps.authToken, now)) return json({ error: 'Unauthorized' }, 401)
  if (!deps.uploads) return json({ error: 'Upload API is not configured' }, 501)
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST' })
  const contentLength = request.headers.get('content-length')
  if (
    contentLength !== null &&
    deps.maxRequestBodyBytes !== undefined &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > deps.maxRequestBodyBytes
  )
    return json({ error: 'Request body is too large' }, 413)
  try {
    const file = (await request.formData()).get('file')
    if (!(file instanceof File)) return json({ error: 'file is required' }, 400)
    return json({ upload: await deps.uploads.stage(file) })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
}

async function handleWebStatusRequest(request: Request, deps: AppServerDeps, now: number): Promise<Response> {
  if (!isAuthorized(request, deps.authToken, now)) return json({ error: 'Unauthorized' }, 401)
  if (!deps.webStatus) return json({ error: 'Web status is not configured' }, 501)
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { allow: 'GET' })
  return json({ status: await deps.webStatus.get() })
}

async function handleSettingsRequest(request: Request, deps: AppServerDeps, now: number): Promise<Response> {
  if (!isAuthorized(request, deps.authToken, now)) return json({ error: 'Unauthorized' }, 401)
  if (!deps.settings) return json({ error: 'Settings API is not configured' }, 501)
  if (request.method === 'GET') return json({ settings: await deps.settings.read() })
  if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405, { allow: 'GET, PUT' })
  try {
    const settings = JSON.parse(await request.text()) as Record<string, unknown>
    await deps.settings.save(settings)
    return json({ saved: true, restartRequired: true })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
}

async function handleRestartRequest(request: Request, deps: AppServerDeps, now: number): Promise<Response> {
  if (!isAuthorized(request, deps.authToken, now)) return json({ error: 'Unauthorized' }, 401)
  if (!deps.restart) return json({ error: 'Restart API is not configured' }, 501)
  if (request.method === 'GET') return json({ preview: deps.restart.preview() })
  if (request.method === 'POST') return json({ result: await deps.restart.run() })
  return json({ error: 'Method not allowed' }, 405, { allow: 'GET, POST' })
}

async function handleSessionRequest(request: Request, deps: AppServerDeps, now: () => number): Promise<Response> {
  if (!deps.authToken)
    return json({ error: 'Web authentication is unavailable until http.authToken is configured' }, 503)

  if (request.method === 'GET') {
    const currentTime = now()
    if (!isAuthorized(request, deps.authToken, currentTime)) return json({ authenticated: false }, 401)
    return json({ authenticated: true }, 200, {
      'set-cookie': createSessionCookie(deps.authToken, currentTime + SESSION_TTL_MS, deps.secureCookie === true),
    })
  }
  if (request.method === 'POST') {
    if (!hasBearerToken(request, deps.authToken)) return json({ error: 'Unauthorized' }, 401)
    const expiresAt = now() + SESSION_TTL_MS
    return json({ authenticated: true }, 200, {
      'set-cookie': createSessionCookie(deps.authToken, expiresAt, deps.secureCookie === true),
    })
  }
  if (request.method === 'DELETE') {
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
    body = parseCompatibleJson(raw) as MessageRequest
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
    if (!platform) return json({ error: 'platform must be telegram, qq, or web' }, 400)
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
  const file = Bun.file(assetPath ?? deps.staticIndexPath ?? 'public/webui/index.html')
  if (!(await file.exists())) return json({ error: 'Not found' }, 404)
  return new Response(method === 'HEAD' ? null : file, {
    headers: { 'content-type': contentType(assetPath ?? 'index.html') },
  })
}

function looksLikeFileRequest(pathname: string): boolean {
  const segment = pathname.split('/').at(-1) ?? ''
  return segment.includes('.')
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
  return value === 'telegram' || value === 'qq' || value === 'web' ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseCompatibleJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch (strictError) {
    const compatible = escapeUnescapedJsonStringControls(raw)
    if (compatible === raw) throw strictError
    return JSON.parse(compatible) as unknown
  }
}

function escapeUnescapedJsonStringControls(raw: string): string {
  let result = ''
  let inString = false
  let escaped = false

  for (const character of raw) {
    if (!inString) {
      result += character
      if (character === '"') inString = true
      continue
    }
    if (escaped) {
      result += character
      escaped = false
      continue
    }
    if (character === '\\') {
      result += character
      escaped = true
      continue
    }
    if (character === '"') {
      result += character
      inString = false
      continue
    }
    const codePoint = character.codePointAt(0)
    result += codePoint !== undefined && codePoint < 0x20 ? `\\u${codePoint.toString(16).padStart(4, '0')}` : character
  }

  return result
}

function isAuthorized(request: Request, authToken: string, now: number): boolean {
  if (!authToken) return false
  if (hasBearerToken(request, authToken)) return true
  const session = readCookie(request.headers.get('cookie'), 'ai_cli_hub_session')
  return session ? verifySession(session, authToken, now) : false
}

function isAllowedWebSocketOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  let originHost: string
  try {
    originHost = new URL(origin).host.toLowerCase()
  } catch {
    return false
  }

  const forwardedHosts = (request.headers.get('x-forwarded-host') ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  const allowedHosts = new Set([
    new URL(request.url).host.toLowerCase(),
    request.headers.get('host')?.trim().toLowerCase() ?? '',
    ...forwardedHosts,
  ])
  return allowedHosts.has(originHost)
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

function createSessionCookie(authToken: string, expiresAt: number, secure: boolean): string {
  const payload = `v1.${expiresAt}`
  const signature = createHmac('sha256', authToken).update(payload).digest('base64url')
  return `ai_cli_hub_session=${encodeURIComponent(`${payload}.${signature}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`
}

function clearSessionCookie(secure: boolean): string {
  return `ai_cli_hub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`
}

function verifySession(session: string, authToken: string, now: number): boolean {
  const [version, rawExpiresAt, signature, ...extra] = session.split('.')
  if (version !== 'v1' || !/^\d+$/.test(rawExpiresAt ?? '') || !signature || extra.length) return false
  const expiresAt = Number(rawExpiresAt)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false
  const expected = createHmac('sha256', authToken).update(`${version}.${rawExpiresAt}`).digest()
  let received: Buffer
  try {
    received = Buffer.from(signature, 'base64url')
  } catch {
    return false
  }
  return received.length === expected.length && timingSafeEqual(received, expected)
}

function json(body: Record<string, unknown>, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers })
}
