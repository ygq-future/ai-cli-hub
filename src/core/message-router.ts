/**
 * MessageRouter —— 消息路由（docs/02-Architecture.md §3.2 / §4.1）。
 *
 * 职责：
 *  - 订阅 MessageReceived 事件
 *  - 定位/创建会话
 *  - 保存用户消息到 DB
 *  - 触发 Adapter 处理（M3 用 MockHandler 模拟；M4 接入真实 CLIAdapter）
 *  - 发射 MessageGenerated 事件
 *
 * MockHandler 是 M3 的进程占位，打通「收消息→路由→存库→回消息」闭环。
 */
import type { ConversationId, Unsubscribe } from '../shared'
import type { EventBus } from '../event'
import type { Repositories } from '../repository/types'
import type { SessionManager } from './session-manager'

/**
 * M3 的模拟 Adapter 处理句柄。
 * 真实场景（M4+）由 CLIAdapter 替代。
 *
 * onMessage 接收 (text, conversationId)，返回响应文本（或空字符串表示无响应）。
 */
export interface MockHandler {
  onMessage(text: string, conversationId: ConversationId): Promise<string>
}

export interface MessageRouter {
  destroy(): void
}

export function createMessageRouter(
  bus: EventBus,
  repos: Repositories,
  sessionManager: SessionManager,
  handler?: MockHandler,
): MessageRouter {
  const unsubs: Unsubscribe[] = []

  // 订阅 MessageReceived
  const unsub = bus.on('MessageReceived', async payload => {
    const { conversationId, text } = payload

    try {
      // 保存用户消息（角色=user）
      const msgId = crypto.randomUUID()
      await repos.messages.append({
        id: msgId,
        conversationId,
        role: 'user',
        content: text,
        createdAt: Date.now(),
      })

      // 使用 MockHandler 生成响应
      if (handler) {
        const response = await handler.onMessage(text, conversationId)
        if (response) {
          const respId = crypto.randomUUID()
          // 保存 assistant 消息
          await repos.messages.append({
            id: respId,
            conversationId,
            role: 'assistant',
            content: response,
            createdAt: Date.now(),
          })

          // 发射 MessageGenerated 事件
          bus.emit('MessageGenerated', {
            conversationId,
            content: response,
            final: true,
          })
        }
      }
    } catch (err) {
      bus.emit('ErrorOccurred', {
        scope: 'router:MessageReceived',
        message: err instanceof Error ? err.message : String(err),
        conversationId,
      })
    }
  })
  unsubs.push(unsub)

  return {
    destroy() {
      for (const u of unsubs) u()
      unsubs.length = 0
    },
  }
}
