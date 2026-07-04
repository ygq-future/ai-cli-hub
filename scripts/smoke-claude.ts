/**
 * 真实端到端验证：用 ClaudeSdkAdapter 发消息，经历完整消息流（text + tool_use + tool_result + thinking）。
 * 跑了就让用户知道适配器真正能和 claude SDK 连通干活。
 * 手动跑：bun scripts/smoke-claude.ts
 */
import { createClaudeSdkAdapter, type OutputDelta } from '../src/cli'
import type { ConversationId } from '../src/shared'

const adapter = createClaudeSdkAdapter()
const deltas: Array<OutputDelta> = []

adapter.onOutput(d => {
  deltas.push(d)
  process.stdout.write(`[${d.kind}]`)
  if (d.kind === 'tool_use' && d.toolName) {
    process.stdout.write(` ${d.toolName}\n`)
  } else if (d.text) {
    process.stdout.write(` ${d.text}\n`)
  } else if (d.final) {
    process.stdout.write(' (final)\n')
  }
})

adapter.onApprovalRequest(r => {
  console.log(`[审批] ${r.command} — 自动放行`)
  adapter.resolveApproval(r.approvalId, 'approve')
})

adapter.onExit(info => {
  console.log(`\n[退出] code=${info.code} reason=${info.reason}`)
  console.log('\n=== 按 kind 统计 ===')
  const byKind: Record<string, number> = {}
  for (const d of deltas) {
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1
  }
  console.table(byKind)
  console.log('总 delta 数:', deltas.length)
  console.log('kind 集合:', [...new Set(deltas.map(d => d.kind))].join(', '))
  // 验证关键 message type 都出现了
  const kinds = new Set(deltas.map(d => d.kind))
  const hasText = kinds.has('text')
  const hasToolUse = kinds.has('tool_use')
  const hasToolResult = kinds.has('tool_result')
  const hasFinal = deltas.some(d => d.final)
  if (hasText && hasToolUse && hasToolResult && hasFinal) {
    console.log('\n✅ 全部消息类型都出现了：text + tool_use + tool_result + final')
    process.exit(0)
  } else {
    console.error(
      `\n❌ 缺失类型：text=${hasText} tool_use=${hasToolUse} tool_result=${hasToolResult} final=${hasFinal}`,
    )
    process.exit(1)
  }
})

console.log('启动适配器，发送 "Read package.json 的 name 字段"...')
await adapter.start({ conversationId: 'smoke' as ConversationId, cwd: process.cwd() })
adapter.sendUserInput('Read the "name" field in package.json and tell me what it is.')

setTimeout(() => {
  console.error('\n!!! 90s 超时 !!!')
  void adapter.stop().then(() => process.exit(1))
}, 90_000)
