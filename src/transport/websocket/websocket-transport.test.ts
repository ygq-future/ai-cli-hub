import { expect, test } from 'bun:test'
import { createEventBus } from '../../event'
import type { ConversationId } from '../../shared'
import { createWebSocketTransport, type WebSocketGateway, type WebSocketPeer } from './websocket-transport'

function createGateway(connected = true) {
  let receiver: ((peer: WebSocketPeer, data: string) => void) | null = null
  const sent: string[] = []
  const peer: WebSocketPeer = { send: data => sent.push(data), close: () => undefined }
  const gateway: WebSocketGateway = {
    setReceiver(next) {
      receiver = next
    },
    broadcast(data) {
      if (!connected) return 0
      sent.push(data)
      return 1
    },
    waitForPeer: async () => undefined,
    add() {
      return true
    },
    remove() {},
    receive(nextPeer, data) {
      receiver?.(nextPeer, data)
    },
  }
  return { gateway, peer, sent }
}

test('WebSocket transport 只在客户端在线时用 output 事件发送服务通知', async () => {
  const bus = createEventBus()
  const online = createGateway()
  const transport = createWebSocketTransport({ bus, gateway: online.gateway, userId: 'web-admin' })
  await transport.start()

  await transport.sendMessage('web-admin', '服务已恢复')
  expect(online.sent.map(data => JSON.parse(data))).toEqual([
    { v: 1, type: 'output', content: '服务已恢复', final: true },
  ])
  await transport.stop()

  const offline = createGateway(false)
  const offlineTransport = createWebSocketTransport({ bus, gateway: offline.gateway, userId: 'web-admin' })
  await offlineTransport.start()
  expect(offlineTransport.sendMessage('web-admin', '不会丢失')).rejects.toThrow('No WebSocket client connected')
  await offlineTransport.stop()
})

test('WebSocket transport 将 CommandReply 回传给触发命令的浏览器', async () => {
  const bus = createEventBus()
  const { gateway, sent } = createGateway()
  const transport = createWebSocketTransport({ bus, gateway, userId: 'web-admin' })
  await transport.start()

  bus.emit('CommandReply', {
    ref: { platform: 'web', chatId: 'web-admin', nativeId: 'request-1' },
    content: '## Help\n\nAvailable commands',
  })

  expect(sent.map(data => JSON.parse(data))).toEqual([
    { v: 1, type: 'output', content: '## Help\n\nAvailable commands', final: true },
  ])
  await transport.stop()
})

test('WebSocket transport 在浏览器内直接响应 /help', async () => {
  const bus = createEventBus()
  const { gateway, peer, sent } = createGateway()
  const transport = createWebSocketTransport({
    bus,
    gateway,
    userId: 'web-admin',
    resolveUserLanguage: () => 'zh',
  })
  await transport.start()

  gateway.receive(peer, JSON.stringify({ v: 1, type: 'message', text: '/help' }))
  await Promise.resolve()

  const reply = JSON.parse(sent[0] ?? '{}') as { type?: string; content?: string; final?: boolean }
  expect(reply.type).toBe('output')
  expect(reply.content).toContain('可用命令')
  expect(reply.final).toBe(true)
  await transport.stop()
})

test('WebSocket transport 每条普通消息读取当前用户目标', async () => {
  const bus = createEventBus()
  const { gateway, peer } = createGateway()
  const received: Array<{ cli: string; cwd: string }> = []
  let target: { cli: 'claude' | 'opencode'; cwd: string } = { cli: 'claude', cwd: '/' }
  bus.on('MessageReceived', message => received.push({ cli: message.cli, cwd: message.cwd }))
  const transport = createWebSocketTransport({
    bus,
    gateway,
    userId: 'web-admin',
    resolveUserTarget: async () => target,
  })
  await transport.start()

  target = { cli: 'opencode', cwd: '/home/ubuntu/ai-workspace/.opencode-web' }
  gateway.receive(peer, JSON.stringify({ v: 1, type: 'message', text: '第一次普通对话' }))
  await new Promise(resolve => setTimeout(resolve, 0))

  expect(received).toEqual([{ cli: 'opencode', cwd: '/home/ubuntu/ai-workspace/.opencode-web' }])
  await transport.stop()
})

test('WebSocket transport 保留用户原文，并把媒体预处理结果单独交给 Core', async () => {
  const bus = createEventBus()
  const { gateway, peer } = createGateway()
  const received: Array<{ text: string; promptText?: string; ref: { nativeId: string }; attachments?: unknown[] }> = []
  bus.on('MessageReceived', message => received.push(message))
  const transport = createWebSocketTransport({
    bus,
    gateway,
    userId: 'web-admin',
    resolveUploads: async () => [
      {
        kind: 'photo',
        fileName: 'screen.png',
        mimeType: 'image/png',
        fileSize: 12,
        localPath: '/tmp/screen.png',
      },
    ],
    mediaPreprocessor: {
      async preprocess() {
        return { text: '原始问题\n\n[File preprocessing context]\nocr_text=内部内容', warnings: [] }
      },
    },
  })
  await transport.start()

  gateway.receive(
    peer,
    JSON.stringify({
      v: 1,
      type: 'message',
      text: '@read2 原始问题',
      uploadIds: ['upload-1'],
      clientMessageId: 'client-1',
    }),
  )
  await new Promise(resolve => setTimeout(resolve, 0))

  expect(received).toEqual([
    expect.objectContaining({
      text: '@read2 原始问题',
      promptText: '原始问题\n\n[File preprocessing context]\nocr_text=内部内容',
      ref: expect.objectContaining({ nativeId: 'client-1' }),
      attachments: [expect.objectContaining({ fileName: 'screen.png' })],
    }),
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
    platform: 'web',
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

test('WebSocket transport 回传规范化用户消息和预览附件', async () => {
  const bus = createEventBus()
  const { gateway, sent } = createGateway()
  const transport = createWebSocketTransport({ bus, gateway, userId: 'web-admin' })
  await transport.start()
  const conversationId = 'web-conversation' as ConversationId
  bus.emit('MessagePersisted', {
    conversationId,
    ref: { platform: 'web', chatId: 'web-admin', nativeId: 'client-1' },
    message: {
      id: 'message-1',
      role: 'user',
      content: '@read2 原始问题',
      attachments: [
        {
          id: 'file-2',
          kind: 'photo',
          fileName: 'screen.png',
          mimeType: 'image/png',
          fileSize: 12,
        },
      ],
      createdAt: 1,
    },
  })
  bus.emit('CommandReply', {
    ref: { platform: 'web', chatId: 'web-admin', nativeId: 'client-2' },
    content: '## 文件预览',
    attachments: [
      {
        id: 'file-2',
        kind: 'photo',
        fileName: 'screen.png',
        mimeType: 'image/png',
        fileSize: 12,
      },
    ],
  })

  expect(sent.map(data => JSON.parse(data))).toEqual([
    {
      v: 1,
      type: 'user_message',
      clientMessageId: 'client-1',
      message: expect.objectContaining({ id: 'message-1', content: '@read2 原始问题' }),
    },
    {
      v: 1,
      type: 'output',
      content: '## 文件预览',
      final: true,
      attachments: [expect.objectContaining({ id: 'file-2' })],
    },
  ])
  await transport.stop()
})

test('WebSocket transport 拒绝超长消息和过多上传 ID', async () => {
  const bus = createEventBus()
  const { gateway, peer, sent } = createGateway()
  const received: unknown[] = []
  bus.on('MessageReceived', message => received.push(message))
  const transport = createWebSocketTransport({ bus, gateway, userId: 'web-admin' })
  await transport.start()

  gateway.receive(peer, JSON.stringify({ v: 1, type: 'message', text: 'x'.repeat(64 * 1024 + 1) }))
  gateway.receive(
    peer,
    JSON.stringify({
      v: 1,
      type: 'message',
      text: 'hello',
      uploadIds: Array.from({ length: 11 }, (_, index) => `upload-${index}`),
    }),
  )

  expect(sent.map(data => JSON.parse(data))).toEqual([
    { v: 1, type: 'error', code: 'message_too_large' },
    { v: 1, type: 'error', code: 'too_many_uploads' },
  ])
  expect(received).toEqual([])
  await transport.stop()
})

test('WebSocket transport 只允许已知 Web 会话提交审批', async () => {
  const bus = createEventBus()
  const { gateway, peer, sent } = createGateway()
  const approved: unknown[] = []
  bus.on('ApprovalApproved', event => approved.push(event))
  const transport = createWebSocketTransport({ bus, gateway, userId: 'web-admin' })
  await transport.start()

  gateway.receive(peer, JSON.stringify({ v: 1, type: 'approve', conversationId: 'unknown', approvalId: 'approval-1' }))
  expect(approved).toEqual([])
  expect(JSON.parse(sent.at(-1) ?? '{}')).toEqual({
    v: 1,
    type: 'error',
    code: 'conversation_unavailable',
  })

  const conversationId = 'web-conversation' as ConversationId
  bus.emit('SessionMapped', {
    conversationId,
    platform: 'web',
    userId: 'web-admin',
  })
  gateway.receive(peer, JSON.stringify({ v: 1, type: 'approve', conversationId, approvalId: 'approval-2' }))
  expect(approved).toEqual([{ conversationId, approvalId: 'approval-2', operator: 'web-admin' }])
  await transport.stop()
})

test('WebSocket transport 下发手动与自动审批终态，并对重复操作返回已处理', async () => {
  const bus = createEventBus()
  const { gateway, peer, sent } = createGateway()
  const approved: unknown[] = []
  const rejected: unknown[] = []
  bus.on('ApprovalApproved', event => approved.push(event))
  bus.on('ApprovalRejected', event => rejected.push(event))
  const transport = createWebSocketTransport({ bus, gateway, userId: 'web-admin' })
  await transport.start()
  const conversationId = 'web-conversation' as ConversationId
  bus.emit('SessionMapped', { conversationId, platform: 'web', userId: 'web-admin' })

  bus.emit('ApprovalRequested', {
    conversationId,
    approvalId: 'approval-auto',
    command: 'Bash',
    detail: '{"command":"git pull"}',
    createdAt: 100,
  })
  bus.emit('ApprovalApproved', {
    conversationId,
    approvalId: 'approval-auto',
    operator: 'auto:web-admin',
    automatic: true,
  })
  bus.emit('ApprovalRejected', {
    conversationId,
    approvalId: 'approval-manual',
    operator: 'web-admin',
  })

  expect(sent.map(data => JSON.parse(data))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        v: 1,
        type: 'approval',
        approvalId: 'approval-auto',
        createdAt: 100,
      }),
      {
        v: 1,
        type: 'approval_resolved',
        conversationId,
        approvalId: 'approval-auto',
        status: 'approved',
        operator: 'auto:web-admin',
        automatic: true,
      },
      {
        v: 1,
        type: 'approval_resolved',
        conversationId,
        approvalId: 'approval-manual',
        status: 'rejected',
        operator: 'web-admin',
        automatic: false,
      },
    ]),
  )

  const approvedBeforeDuplicate = approved.length
  gateway.receive(peer, JSON.stringify({ v: 1, type: 'approve', conversationId, approvalId: 'approval-auto' }))
  expect(approved).toHaveLength(approvedBeforeDuplicate)
  expect(JSON.parse(sent.at(-1) ?? '{}')).toEqual({
    v: 1,
    type: 'approval_resolved',
    conversationId,
    approvalId: 'approval-auto',
    status: 'approved',
    operator: 'auto:web-admin',
    automatic: true,
    alreadyHandled: true,
  })
  expect(rejected).toHaveLength(1)
  await transport.stop()
})
