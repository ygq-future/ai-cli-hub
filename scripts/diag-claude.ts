/**
 * 诊断：让 claude 真执行一个工具（读文件），dump SDK 发来的每一条原始消息，
 * 看清真实消息流 —— 验证 ClaudeSdkAdapter.handleMessage 到底漏没漏东西。
 * 手动跑：bun scripts/diag-claude.ts
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

async function* input() {
  yield {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: "Create a file named smoke-tmp.txt in the current directory with the text 'hi'.",
    },
    parent_tool_use_id: null,
  }
}

// 审批名单：只审写操作
const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])

const q = query({
  prompt: input(),
  options: {
    cwd: process.cwd(),
    canUseTool: async (toolName, toolInput, { toolUseID }) => {
      const must = !AUTO_ALLOW.has(toolName)
      console.log(`\n>>> [canUseTool 触发] tool=${toolName} 必审=${must} toolUseID=${toolUseID}`)
      // Zod schema 要求 allow 必须传 updatedInput（可为空对象）+ toolUseID
      return { behavior: 'allow', updatedInput: {}, toolUseID }
    },
  },
})

let i = 0
for await (const msg of q) {
  i++
  const m = msg as Record<string, unknown>
  console.log(`\n[#${i}] type=${m.type}${m.subtype ? ` subtype=${m.subtype}` : ''}`)
  if (m.type === 'assistant' || m.type === 'user') {
    const content = (m.message as Record<string, unknown> | undefined)?.content
    if (Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        // tool_result 打印完整（看 ZodError 全文），其余截断
        const slice = b.type === 'tool_result' ? 2000 : 2000
        console.log(`   block type=${b.type}`, JSON.stringify(b).slice(0, slice))
      }
    } else {
      console.log('   content=', JSON.stringify(content).slice(0, 150))
    }
  }
  if (m.type === 'result') console.log('   result=', JSON.stringify(m.result).slice(0, 150))
}
console.log('\n=== 消息流结束 ===')
process.exit(0)
