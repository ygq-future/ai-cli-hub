import { describe, expect, test } from 'bun:test'
import { createQQBotClient, type QQGatewayStatusUpdate } from './qq-bot-client'

type Handler = (...args: unknown[]) => void

class FakeWebSocket {
  readyState = 1
  readonly sent: string[] = []
  private readonly handlers = new Map<string, Handler[]>()

  on(event: string, handler: Handler): this {
    const handlers = this.handlers.get(event) ?? []
    handlers.push(handler)
    this.handlers.set(event, handlers)
    return this
  }

  send(payload: string) {
    this.sent.push(payload)
  }

  close() {
    this.emit('close', 1000)
  }

  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('QQBotClient Gateway startup', () => {
  test('start 必须等到 READY 后才 resolve，并报告可诊断的状态', async () => {
    const socket = new FakeWebSocket()
    const statuses: QQGatewayStatusUpdate[] = []
    const client = createQQBotClient({
      appId: 'app-id',
      appSecret: 'app-secret',
      gatewayReadyTimeoutMs: 1_000,
      fetchFn: (async (url: string) => {
        if (url === 'https://bots.qq.com/app/getAppAccessToken')
          return jsonResponse({ access_token: 'token', expires_in: 7200 })
        if (url === 'https://api.sgroup.qq.com/gateway') return jsonResponse({ url: 'wss://gateway.example.test' })
        throw new Error(`Unexpected URL: ${url}`)
      }) as unknown as typeof fetch,
      webSocketFactory: () => socket as never,
    })

    let resolved = false
    const starting = client
      .start(
        () => undefined,
        status => statuses.push(status),
      )
      .then(() => {
        resolved = true
      })
    // connect() 内的 /gateway 请求与 getAccessToken 均为异步，反复清空微任务队列直到 WebSocket 建立。
    const flush = async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve()
    }
    await flush()

    socket.emit('open')
    socket.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))
    await flush()
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({ op: 2, d: { intents: (1 << 25) | (1 << 26) } })
    expect(resolved).toBe(false)

    socket.emit('message', JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1' } }))
    await starting

    expect(statuses).toEqual([
      { state: 'connecting', detail: '正在请求腾讯 QQ Bot Gateway 地址' },
      { state: 'connecting', detail: '已获取 Gateway 地址，正在建立 WebSocket：wss://gateway.example.test' },
      { state: 'connecting', detail: 'WebSocket 已连接，等待 Gateway HELLO(op=10)' },
      { state: 'identifying', detail: '正在识别 QQ Bot 身份' },
      { state: 'ready', detail: 'Gateway READY，session=session-1' },
    ])
    await client.stop()
  })
})
