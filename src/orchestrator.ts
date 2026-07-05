/**
 * SessionOrchestrator —— Composition-Root 层的会话↔adapter 编排器。
 *
 * 为什么在这里（不在 core/）：core/ 禁止依赖 cli/（依赖矩阵），但「把用户输入喂给真实
 * CLIAdapter、把 adapter 的流式输出接进聚合器」必然同时触碰 cli+core+repository。这类装配
 * 只允许发生在 Composition Root（main.ts 及其同级根层文件），故落在本文件。
 *
 * 职责（每会话一个 adapter，决策见 M6 计划）：
 *  - 实现 core 的 MessageHandler 接缝注入 MessageRouter：onMessage(text, cid) 懒启动/复用
 *    该会话的 adapter，接线输出→聚合器，喂入用户输入；返回空串（输出走聚合器异步流）。
 *  - adapter.onApprovalRequest → emit ApprovalRequested（补上 conversationId）。
 *  - 订阅 ApprovalApproved/ApprovalRejected → adapter.resolveApproval。
 *  - 助手消息落库：累计本轮输出文本，delta.final 时落一条 assistant 消息。
 *  - adapter.onExit → 冲刷聚合器 + 清理该会话。
 */
import type { ConversationId, Unsubscribe } from './shared'
import type { EventBus } from './event'
import type { Repositories } from './repository'
import type { MessageAggregator, MessageHandler } from './core'
import { createClaudeSdkAdapter, formatOutputDelta, type CLIAdapter } from './cli'

export interface SessionOrchestrator {
  /** 注入 CoreHub 的输入处理接缝。 */
  handler: MessageHandler
  /** 停止所有 adapter 与订阅（优雅关闭）。 */
  destroy(): void
}

export interface SessionOrchestratorDeps {
  bus: EventBus
  repos: Repositories
  aggregator: MessageAggregator
  /** adapter 工厂（默认 Claude SDK 家族）；测试可注入假 adapter。 */
  adapterFactory?: () => CLIAdapter
}

interface AdapterEntry {
  adapter: CLIAdapter
  unsubs: Unsubscribe[]
  /** 本轮助手输出累计文本（delta.final 时落库并清空）。 */
  assistantBuf: string
}

export function createSessionOrchestrator(deps: SessionOrchestratorDeps): SessionOrchestrator {
  const { bus, repos, aggregator } = deps
  const adapterFactory = deps.adapterFactory ?? createClaudeSdkAdapter

  const entries = new Map<ConversationId, AdapterEntry>()
  const globalUnsubs: Unsubscribe[] = []

  function reportError(scope: string, err: unknown, conversationId?: ConversationId) {
    bus.emit('ErrorOccurred', {
      scope,
      message: err instanceof Error ? err.message : String(err),
      ...(conversationId ? { conversationId } : {}),
    })
  }

  function cleanupEntry(cid: ConversationId) {
    const entry = entries.get(cid)
    if (!entry) return
    for (const u of entry.unsubs) u()
    entries.delete(cid)
  }

  /** 懒启动该会话的 adapter 并接线；已存在则复用。 */
  async function ensureAdapter(cid: ConversationId): Promise<AdapterEntry | null> {
    const existing = entries.get(cid)
    if (existing) return existing

    const conv = await repos.conversations.findById(cid)
    if (!conv) {
      reportError('orchestrator:ensureAdapter', new Error(`会话 ${cid} 不存在`), cid)
      return null
    }

    const adapter = adapterFactory()
    const entry: AdapterEntry = { adapter, unsubs: [], assistantBuf: '' }
    entries.set(cid, entry)

    // 输出流：格式化 → 聚合器；累计助手文本；final 冲刷 + 落库
    entry.unsubs.push(
      adapter.onOutput(delta => {
        const text = formatOutputDelta(delta)
        if (text) {
          aggregator.push(cid, text)
          entry.assistantBuf += text
        }
        if (delta.final) {
          aggregator.flush(cid)
          void persistAssistant(cid, entry)
        }
      }),
    )

    // 审批请求：补 conversationId 后广播
    entry.unsubs.push(
      adapter.onApprovalRequest(req => {
        bus.emit('ApprovalRequested', {
          conversationId: cid,
          approvalId: req.approvalId,
          command: req.command,
          detail: req.detail,
        })
      }),
    )

    // 退出：冲刷 + 清理
    entry.unsubs.push(
      adapter.onExit(() => {
        aggregator.flush(cid)
        cleanupEntry(cid)
      }),
    )

    try {
      await adapter.start({ conversationId: cid, cwd: conv.cwd })
    } catch (err) {
      reportError('orchestrator:start', err, cid)
      cleanupEntry(cid)
      return null
    }
    return entry
  }

  /** 落一条 assistant 消息（本轮全文），失败只报错不阻塞。 */
  async function persistAssistant(cid: ConversationId, entry: AdapterEntry) {
    const content = entry.assistantBuf
    entry.assistantBuf = ''
    if (!content.trim()) return
    try {
      await repos.messages.append({
        id: crypto.randomUUID(),
        conversationId: cid,
        role: 'assistant',
        content,
        createdAt: Date.now(),
      })
    } catch (err) {
      reportError('orchestrator:persistAssistant', err, cid)
    }
  }

  // 审批决议：路由回对应会话的 adapter
  globalUnsubs.push(
    bus.on('ApprovalApproved', p => {
      entries.get(p.conversationId)?.adapter.resolveApproval(p.approvalId, 'approve')
    }),
  )
  globalUnsubs.push(
    bus.on('ApprovalRejected', p => {
      entries.get(p.conversationId)?.adapter.resolveApproval(p.approvalId, 'reject')
    }),
  )

  const handler: MessageHandler = {
    async onMessage(text, conversationId) {
      const entry = await ensureAdapter(conversationId)
      if (!entry) return ''
      entry.adapter.sendUserInput(text)
      return '' // 输出经聚合器异步流出，不经 handler 返回值
    },
  }

  return {
    handler,
    destroy() {
      for (const u of globalUnsubs) u()
      globalUnsubs.length = 0
      for (const [cid, entry] of entries) {
        for (const u of entry.unsubs) u()
        void entry.adapter.stop().catch(err => reportError('orchestrator:stop', err, cid))
      }
      entries.clear()
    },
  }
}
