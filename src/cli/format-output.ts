/**
 * formatOutputDelta —— 把 CLIAdapter 的语义化 OutputDelta 转成「面向用户的展示字符串」，
 * 供 MessageAggregator.push 吃入（聚合器只处理字符串，见 core/aggregator）。
 *
 * 归属 cli/：仅依赖 OutputDelta（cli/base），不碰 core/ 聚合器——转换与聚合解耦。
 * 接线（onOutput → format → push；final → flush）在 Composition Root（main.ts）完成。
 *
 * 映射规则：
 *  - text / tool_result / thinking：直出 delta.text
 *  - tool_use：delta.text 为空，合成一行工具调用摘要「🔧 ToolName(args)」
 * final=true 的收尾 delta（text 常为空）返回 '' → 聚合器 push 空串为 no-op，
 * 由 Composition Root 据 delta.final 调 flush 收尾。
 */
import type { OutputDelta } from './base'

export function formatOutputDelta(delta: OutputDelta): string {
  switch (delta.kind) {
    case 'text':
    case 'tool_result':
    case 'thinking':
      return delta.text
    case 'tool_use': {
      const name = delta.toolName ?? 'tool'
      const args = delta.toolInput ? JSON.stringify(delta.toolInput) : ''
      return `\n🔧 ${name}(${args})\n`
    }
  }
}
