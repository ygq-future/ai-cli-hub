/**
 * Transport 契约 —— 客户端接入层的统一收发能力（docs/03-Interface-Contracts.md §2）。
 * 叶子类型：仅引用 shared 内的 Platform / MessageRef，不依赖任何业务模块。
 *
 * 实现约束（各 Transport 遵守）：
 *  - 入站：收到消息 → 白名单校验 → 非白名单**静默丢弃**（不进 Core）→ 白名单则 emit MessageReceived。
 *  - 出站：订阅 MessageGenerated（流式 editMessage）与 ApprovalRequested（sendApproval）。
 *  - 审批按钮点击 → emit ApprovalApproved | ApprovalRejected。
 */
import type { MessageRef, Platform } from './common'

export interface Transport {
  readonly platform: Platform

  start(): Promise<void>
  stop(): Promise<void>

  sendMessage(chatId: string, content: string): Promise<MessageRef>
  editMessage(ref: MessageRef, content: string): Promise<void>
  deleteMessage(ref: MessageRef): Promise<void>
  sendApproval(chatId: string, card: ApprovalCard): Promise<MessageRef>
}

/** 审批卡内容（内联按钮固定为 [Approve] / [Reject]，由 Transport 渲染）。 */
export interface ApprovalCard {
  approvalId: string
  title: string // Markdown 标题
  command: string // 待审批命令 / 工具名
  detail: string // 上下文说明
  /** 存在时只展示拒绝按钮，并在到期前显示自动批准倒计时。 */
  autoApproveAt?: number
}
