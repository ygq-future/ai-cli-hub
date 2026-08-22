import type { ConversationId } from '../../shared'
import { requestJson } from './http-client'

export interface ChatStatus {
  platform: 'web'
  conversationId: ConversationId | null
  cli: string
  cwd: string
  sessionStatus: string
  model: { id: string; name: string } | null
  autoApprove: { enabled: boolean; seconds: number }
}

export interface ChatHistoryResponse<T> {
  messages: T[]
  nextCursor: string | null
}

export function getChatStatus(): Promise<{ status: ChatStatus }> {
  return requestJson('/api/web/status')
}

export function getChatHistory<T>(before: string | null, limit = 10): Promise<ChatHistoryResponse<T>> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before) params.set('before', before)
  return requestJson(`/api/web/history?${params.toString()}`)
}

export async function uploadChatFile(
  file: File,
): Promise<{ upload: { id: string; name: string; mimeType: string; size: number } }> {
  const form = new FormData()
  form.set('file', file)
  return requestJson('/api/web/uploads', { method: 'POST', body: form })
}
