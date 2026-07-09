/**
 * formatOutputDelta —— 把 CLIAdapter 的语义化 OutputDelta 转成「面向用户的展示字符串」，
 * 供 MessageAggregator.push 吃入（聚合器只处理字符串，见 core/aggregator）。
 *
 * 归属 cli/：仅依赖 OutputDelta（cli/base），不碰 core/ 聚合器——转换与聚合解耦。
 * 接线（onOutput → format → push；final → flush）在 Composition Root（main.ts）完成。
 *
 * 映射规则：
 *  - text：清洗后直出 delta.text
 *  - thinking / tool_use / tool_result：不对用户展示
 * final=true 的收尾 delta（text 常为空）返回 '' → 聚合器 push 空串为 no-op，
 * 由 Composition Root 据 delta.final 调 flush 收尾。
 */
import type { OutputDelta } from './base'

export function formatOutputDelta(delta: OutputDelta): string {
  switch (delta.kind) {
    case 'text':
      return sanitizeVisibleText(delta.text)
    case 'thinking':
    case 'tool_result':
    case 'tool_use':
      return ''
  }
}

export function sanitizeVisibleText(text: string): string {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<system-role>[\s\S]*?<\/system-role>/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/^\s*[\s\S]*?<\/system-reminder>\s*/i, '')
    .replace(/^\s*Wait for all results before deciding next steps\.[\s\S]*?<\/system-reminder>\s*/i, '')
    .replace(
      /IMPORTANT: Skills are loaded into the conversation separately via the 'Skill' tool[\s\S]*?(?:<\/think>|(?=\n\S))/gi,
      '',
    )
    .replace(
      /## Skill usage for this turn[\s\S]*?(?:<\/think>|Let me consider other skills that might apply[^\n.]*\.)/gi,
      '',
    )
    .replace(/^\s*# Safety[\s\S]*?<\/think>/i, '')
    .replace(
      /^\s*Do not launch two agents on the same scope of work[\s\S]*?(?=(?:你好|您好|Hello|Hi|I'm|I am|我是|有什么可以帮|$))/i,
      '',
    )
    .replace(
      /^\s*IMPORTANT SYSTEM-ROLE \/ CROSS-CUTTING INSTRUCTIONS:[\s\S]*?(?=(?:你好|您好|Hello|Hi|I'm|I am|我是|有什么可以帮|$))/i,
      '',
    )
    .replace(
      /When you launch a single agent, send it in its own message so the user sees the agent result upon completion\.\s*/gi,
      '',
    )
    .replace(/<\/?(?:think|system-role|system-reminder)>/gi, '')
    .replace(
      /If you see the message "This tool does not support running in the background"[\s\S]*?TaskList at the start of each turn\.\s*/gi,
      '',
    )
    .replace(/^\s*(?:让我先看看相关技能是否适用|Let me check if any skills might apply here)[^\n]*\n?/gim, '')
    .replace(/^\s*(?:看起来这是个简单的.*?不需要调用复杂技能。)[^\n]*\n?/gim, '')

  return cleaned === text ? cleaned : cleaned.trimStart()
}
