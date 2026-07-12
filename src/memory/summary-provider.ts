import type { AppConfig } from '../config'
import type { Message } from '../storage'
import type { UserLanguage } from '../shared'

export interface SummaryProvider {
  summarizeRecentMessages(messages: Message[], userRequest: string, language: UserLanguage): Promise<string>
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown
    }
  }>
}

export function buildSummarySystemPrompt(language: UserLanguage, maxChars: number): string {
  if (language === 'en') {
    return [
      'You are a long-term memory summarizer. Generate one durable memory only from the provided messages table conversation content.',
      'Do not use, infer from, or reference SDK raw JSON, internal tool process, hidden/system prompts, thinking, or log fields.',
      'Output in English, directly as the memory body. Do not output JSON or a title.',
      'Use third-person or neutral factual statements. Do not use pronouns like "you", "I", "we", or "the assistant" that depend on the current conversation identity.',
      'Preserve facts, paths, preferences, project decisions, and operational conclusions that the user explicitly asked to remember.',
      'If the context is insufficient to form a useful memory, output an empty string.',
      `Keep it under ${maxChars} characters.`,
    ].join('\n')
  }

  return [
    '你是长期记忆摘要器。只根据提供的 messages 表对话内容生成一条可长期保存的记忆。',
    '不要使用、猜测或引用 SDK raw JSON、工具内部过程、hidden/system prompt、thinking、日志字段。',
    '输出中文，直接给记忆正文，不要 JSON，不要标题。',
    '使用第三人称或中性事实陈述，不要使用“你/我/我们/助手”等依赖当前对话身份的人称。',
    '保留用户明确要求记住的事实、路径、偏好、项目决策、操作结论。',
    '如果上下文不足以形成有用记忆，输出空字符串。',
    `控制在 ${maxChars} 字以内。`,
  ].join('\n')
}

export function createSummaryProvider(config: AppConfig): SummaryProvider {
  const baseUrl = config.MEMORY_SUMMARY_API_BASE_URL.trim().replace(/\/+$/, '')

  return {
    async summarizeRecentMessages(messages: Message[], userRequest: string, language: UserLanguage): Promise<string> {
      if (!baseUrl || !config.MEMORY_SUMMARY_API_KEY || !config.MEMORY_SUMMARY_MODEL) {
        throw new Error('Memory summary API is not configured')
      }

      const transcript = formatTranscript(messages)
      const systemPrompt = buildSummarySystemPrompt(language, config.MEMORY_SUMMARY_MAX_CHARS)
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.MEMORY_SUMMARY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.MEMORY_SUMMARY_MODEL,
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: buildSummaryUserPrompt(language, userRequest, transcript),
            },
          ],
        }),
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Memory summary API failed: ${res.status} ${detail.slice(0, 500)}`)
      }

      const json = (await res.json()) as ChatCompletionResponse
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('Memory summary API returned invalid payload')
      return content.trim()
    },
  }
}

function buildSummaryUserPrompt(language: UserLanguage, userRequest: string, transcript: string): string {
  if (language === 'en') {
    return [
      `User memory request: ${userRequest}`,
      'Recent conversation content from the messages table:',
      transcript,
      'Summarize it into one long-term memory.',
    ].join('\n\n')
  }

  return [
    `用户触发记忆请求：${userRequest}`,
    '最近 messages 表对话内容如下：',
    transcript,
    '请总结成一条长期记忆。',
  ].join('\n\n')
}

function formatTranscript(messages: Message[]): string {
  return messages
    .map(message => {
      const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : 'system'
      return `[${role}] ${message.content.trim()}`
    })
    .join('\n\n')
}
