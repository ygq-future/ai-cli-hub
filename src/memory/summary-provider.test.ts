import { describe, expect, test } from 'bun:test'
import { buildSummarySystemPrompt } from './summary-provider'

describe('summary provider prompt', () => {
  test('根据用户语言和配置长度生成中文摘要 prompt', () => {
    const prompt = buildSummarySystemPrompt('zh', 123)

    expect(prompt).toContain('输出中文')
    expect(prompt).toContain('第三人称或中性事实陈述')
    expect(prompt).toContain('不要使用“你/我/我们/助手”')
    expect(prompt).toContain('控制在 123 字以内')
    expect(prompt).toContain('不要 JSON')
  })

  test('根据用户语言和配置长度生成英文摘要 prompt', () => {
    const prompt = buildSummarySystemPrompt('en', 456)

    expect(prompt).toContain('Output in English')
    expect(prompt).toContain('third-person or neutral factual statements')
    expect(prompt).toContain('Do not use pronouns like "you", "I", "we", or "the assistant"')
    expect(prompt).toContain('under 456 characters')
    expect(prompt).toContain('Do not output JSON')
  })
})
