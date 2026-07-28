import { expect, test } from 'bun:test'
import { createEventBus } from '../../event'
import type { ConversationId } from '../../shared'
import { createWebSocketTransport, type WebSocketGateway, type WebSocketPeer } from './websocket-transport'

function createGateway() {
  let receiver: ((peer: WebSocketPeer, data: string) => void) | null = null
  const sent: string[] = []
  const peer: WebSocketPeer = { send: data => sent.push(data), close: () => undefined }
  const gateway: WebSocketGateway = {
    setReceiver(next) {
      receiver = next
    },
    broadcast(data) {
      sent.push(data)
    },
    add() {},
    remove() {},
    receive(nextPeer, data) {
      receiver?.(nextPeer, data)
    },
  }
  return { gateway, peer, sent }
}

test('WebSocket transport 将 CommandReply 回传给触发命令的浏览器', async () => {
  const bus = createEventBus()
  const { gateway, sent } = createGateway()
  const transport = createWebSocketTransport({ bus, gateway, userId: 'web-admin' })
  await transport.start()

  bus.emit('CommandReply', {
    ref: { platform: 'websocket', chatId: 'web-admin', nativeId: 'request-1' },
    content: '## Help\n\nAvailable commands',
  })

  expect(sent.map(data => JSON.parse(data))).toEqual([
    { v: 1, type: 'output', content: '## Help\n\nAvailable commands', final: true },
  ])
  await transport.stop()
})

test('WebSocket transport 将已知会话的流式输出回传浏览器', async () => {
  const bus = createEventBus()
  const { gateway, sent } = createGateway()
  const transport = createWebSocketTransport({ bus, gateway, userId: 'web-admin' })
  await transport.start()
  const conversationId = 'web-conversation' as ConversationId
  bus.emit('SessionCreated', {
    conversationId,
    platform: 'websocket',
    userId: 'web-admin',
    cli: 'claude',
    cwd: '/',
  })
  bus.emit('MessageGenerated', { conversationId, content: 'streamed answer', final: false })

  expect(sent.map(data => JSON.parse(data))).toEqual([
    { v: 1, type: 'output', conversationId, content: 'streamed answer', final: false },
  ])
  await transport.stop()
})
