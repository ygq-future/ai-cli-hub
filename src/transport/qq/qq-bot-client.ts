/**
 * 腾讯官方 QQ Bot Gateway + HTTP API 的最小封装。
 *
 * 仅覆盖 AI CLI Hub QQ 私聊所需的 token、Gateway、C2C 文本/流式消息和交互按钮。
 * 协议细节封装在 transport 内，Core 不感知 QQ OpenID、事件 ID 或 Gateway op code。
 */
import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API_BASE = 'https://api.sgroup.qq.com'
const QQBOT_INTENTS = (1 << 25) | (1 << 26) // GROUP_AND_C2C | INTERACTION

export interface QQGatewayEvent {
  type: string
  data: Record<string, unknown>
}

export interface QQKeyboard {
  content: {
    rows: Array<{
      buttons: Array<{
        id: string
        render_data: { label: string; visited_label?: string; style?: 0 | 1 | 2 | 3 | 4 }
        action: { type: 1; data: string; permission: { type: 2 }; click_limit: 1 }
      }>
    }>
  }
}

export interface QQStreamRequest {
  eventId: string
  messageId: string
  content: string
  streamMessageId?: string
  sequence: number
  index: number
  final: boolean
}

export type QQGatewayStatus = 'connecting' | 'identifying' | 'ready' | 'reconnecting' | 'stopped'

export interface QQGatewayStatusUpdate {
  state: QQGatewayStatus
  detail?: string
}

export interface QQBotClient {
  /** 仅在 Gateway 收到 READY/RESUMED 后 resolve，不能把”已创建 WebSocket”误判为在线。 */
  start(onEvent: (event: QQGatewayEvent) => void, onStatus?: (status: QQGatewayStatusUpdate) => void): Promise<void>
  stop(): Promise<void>
  sendC2CMessage(openId: string, content: string, messageId?: string, keyboard?: QQKeyboard): Promise<{ id: string }>
  sendC2CStreamMessage(openId: string, request: QQStreamRequest): Promise<{ id: string }>
  /** 按钮回调 ACK：收到 INTERACTION_CREATE 后 5s 内必须 PUT /interactions/{id} code=0，否则客户端显示失败。 */
  ackInteraction(interactionId: string): Promise<void>
}

export interface QQBotClientDeps {
  appId: string
  appSecret: string
  /** QQ Gateway WebSocket 出网代理（如 http://127.0.0.1:7897）。空则直连；ws 不读环境变量，必须由此显式传入。 */
  wsProxy?: string
  fetchFn?: typeof fetch
  webSocketFactory?: (url: string) => WebSocket
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
  gatewayReadyTimeoutMs?: number
}

interface GatewayPayload {
  op: number
  d?: unknown
  s?: number
  t?: string
}

interface AccessToken {
  token: string
  expiresAt: number
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function createQQBotClient(deps: QQBotClientDeps): QQBotClient {
  const fetchFn = deps.fetchFn ?? fetch
  const proxyAgent = deps.wsProxy ? new HttpsProxyAgent(deps.wsProxy) : undefined
  const webSocketFactory =
    deps.webSocketFactory ?? (url => new WebSocket(url, proxyAgent ? { agent: proxyAgent } : undefined))
  const reconnectDelayMs = deps.reconnectDelayMs ?? 2000
  const maxReconnectDelayMs = deps.maxReconnectDelayMs ?? 60_000
  const gatewayReadyTimeoutMs = deps.gatewayReadyTimeoutMs ?? 15_000
  let token: AccessToken | null = null
  let socket: WebSocket | null = null
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempts = 0
  let stopped = false
  let sequence: number | null = null
  let sessionId: string | null = null
  let onEvent: ((event: QQGatewayEvent) => void) | null = null
  let onStatus: ((status: QQGatewayStatusUpdate) => void) | null = null

  function reportStatus(state: QQGatewayStatus, detail?: string) {
    onStatus?.({ state, detail })
  }

  async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const accessToken = await getAccessToken()
    const response = await fetchFn(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`QQ Bot API ${method} ${path} failed: HTTP ${response.status} ${text}`)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`QQ Bot API ${method} ${path} returned invalid JSON.`)
    }
  }

  async function getAccessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt - 60_000) return token.token
    const response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: deps.appId, clientSecret: deps.appSecret }),
    })
    const data = (await response.json()) as { access_token?: string; expires_in?: number }
    if (!response.ok || !data.access_token) {
      throw new Error(`QQ Bot access token request failed: HTTP ${response.status}`)
    }
    token = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000 }
    return token.token
  }

  function clearTimers() {
    if (heartbeat) clearInterval(heartbeat)
    if (reconnect) clearTimeout(reconnect)
    heartbeat = undefined
    reconnect = undefined
  }

  function scheduleReconnect(detail: string) {
    if (stopped || reconnect) return
    // 指数退避：QQ 的 /gateway 有调用频率限制（40023001），固定 2s 重连会触发限流并放大故障。
    const delay = Math.min(reconnectDelayMs * 2 ** reconnectAttempts, maxReconnectDelayMs)
    reconnectAttempts += 1
    reportStatus('reconnecting', `${detail}; ${delay}ms 后第 ${reconnectAttempts} 次重试`)
    reconnect = setTimeout(() => {
      reconnect = undefined
      void connect().catch(err => scheduleReconnect(`连接失败：${errorMessage(err)}`))
    }, delay)
  }

  function sendGateway(payload: GatewayPayload) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }

  function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    // ws 的 'error' 事件回调收到的是 ErrorEvent 样对象（非 Error 实例），直接 String() 会得到 "[object ErrorEvent]"。
    if (err && typeof err === 'object') {
      const e = err as { message?: unknown; error?: unknown; code?: unknown; type?: unknown }
      const inner = e.error instanceof Error ? e.error : undefined
      const parts = [
        typeof e.message === 'string' && e.message ? e.message : undefined,
        inner ? `cause=${inner.message}` : undefined,
        e.code !== undefined ? `code=${String(e.code)}` : undefined,
        !e.message && typeof e.type === 'string' ? `type=${e.type}` : undefined,
      ].filter(Boolean)
      if (parts.length) return parts.join(' ')
    }
    return String(err)
  }

  async function connect(): Promise<void> {
    reportStatus('connecting', '正在请求腾讯 QQ Bot Gateway 地址')
    const gateway = await request<{ url?: string }>('/gateway', 'GET')
    if (!gateway.url) throw new Error('QQ Bot gateway response did not include url.')
    reportStatus('connecting', `已获取 Gateway 地址，正在建立 WebSocket：${gateway.url}`)
    return new Promise((resolve, reject) => {
      const nextSocket = webSocketFactory(gateway.url!)
      socket = nextSocket
      let settled = false
      const timeout = setTimeout(() => {
        const error = new Error(`QQ Bot Gateway 在 ${gatewayReadyTimeoutMs}ms 内未收到 READY/RESUMED。`)
        fail(error)
        nextSocket.close()
      }, gatewayReadyTimeoutMs)
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reconnectAttempts = 0
        reportStatus('ready', sessionId ? `Gateway READY，session=${sessionId}` : 'Gateway RESUMED')
        resolve()
      }
      const fail = (err: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(err instanceof Error ? err : new Error(errorMessage(err)))
      }

      nextSocket.on('open', () => {
        reportStatus('connecting', 'WebSocket 已连接，等待 Gateway HELLO(op=10)')
      })
      nextSocket.on('message', raw => {
        let payload: GatewayPayload
        try {
          payload = JSON.parse(raw.toString()) as GatewayPayload
        } catch {
          return
        }
        if (typeof payload.s === 'number') sequence = payload.s
        if (payload.op === 10) {
          const interval = Number(asRecord(payload.d).heartbeat_interval)
          reportStatus(
            'identifying',
            sessionId && sequence !== null ? '正在恢复 QQ Gateway 会话' : '正在识别 QQ Bot 身份',
          )
          void getAccessToken()
            .then(accessToken => {
              if (sessionId && sequence !== null) {
                sendGateway({ op: 6, d: { token: `QQBot ${accessToken}`, session_id: sessionId, seq: sequence } })
              } else {
                sendGateway({ op: 2, d: { token: `QQBot ${accessToken}`, intents: QQBOT_INTENTS, shard: [0, 1] } })
              }
            })
            .catch(err => {
              fail(err)
              nextSocket.close()
            })
          if (heartbeat) clearInterval(heartbeat)
          if (Number.isFinite(interval) && interval > 0) {
            heartbeat = setInterval(() => sendGateway({ op: 1, d: sequence }), interval)
          }
          return
        }
        if (payload.op === 0) {
          if (payload.t === 'READY') {
            sessionId = String(asRecord(payload.d).session_id ?? '') || null
            finish()
          } else if (payload.t === 'RESUMED') {
            finish()
          } else if (payload.t) {
            onEvent?.({ type: payload.t, data: asRecord(payload.d) })
          }
          return
        }
        if (payload.op === 7) {
          nextSocket.close()
          return
        }
        if (payload.op === 9 && payload.d === false) {
          sessionId = null
          sequence = null
        }
      })
      nextSocket.on('close', code => {
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = undefined
        if ([4004, 4006, 4007, 4009].includes(code)) {
          token = null
          if (code !== 4004) {
            sessionId = null
            sequence = null
          }
        }
        const detail = `QQ Gateway 已关闭（code=${code}）`
        fail(new Error(`${detail}，未完成 READY/RESUMED 握手。`))
        scheduleReconnect(detail)
      })
      nextSocket.on('error', err => {
        fail(err)
        nextSocket.close()
      })
    })
  }

  return {
    async start(handler, statusHandler) {
      stopped = false
      onEvent = handler
      onStatus = statusHandler ?? null
      await connect()
    },
    async stop() {
      stopped = true
      clearTimers()
      onEvent = null
      reportStatus('stopped', 'QQ Transport 已停止')
      onStatus = null
      socket?.close(1000)
      socket = null
    },
    async sendC2CMessage(openId, content, messageId, keyboard) {
      // msg_type=2 (Markdown) 才支持格式化渲染与 keyboard 按钮。
      // QQ 要求 markdown 与 keyboard 为独立顶层字段，而非 content 内嵌 JSON。
      const msgType = 2
      const body: Record<string, unknown> = {
        content,
        msg_type: msgType,
        msg_seq: Math.floor(Math.random() * 65_536),
        markdown: { content },
        ...(messageId ? { msg_id: messageId } : {}),
        ...(keyboard ? { keyboard } : {}),
      }
      return request<{ id: string }>(`/v2/users/${openId}/messages`, 'POST', body)
    },
    async ackInteraction(interactionId) {
      await request(`/interactions/${interactionId}`, 'PUT', { code: 0 })
    },
    async sendC2CStreamMessage(openId, requestData) {
      return request<{ id: string }>(`/v2/users/${openId}/stream_messages`, 'POST', {
        input_mode: 'replace',
        input_state: requestData.final ? 10 : 1,
        content_type: 'markdown',
        content_raw: requestData.content,
        event_id: requestData.eventId,
        msg_id: requestData.messageId,
        msg_seq: requestData.sequence,
        index: requestData.index,
        ...(requestData.streamMessageId ? { stream_msg_id: requestData.streamMessageId } : {}),
      })
    },
  }
}
