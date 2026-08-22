import type {
  ConversationDetail,
  ConversationFilePage,
  ConversationId,
  ConversationView,
  CursorPage,
  ConversationDeletionResult,
  TimelinePage,
} from '../../shared'
import { requestJson } from './http-client'
import type { BrowserPageQuery } from './types'

export interface ConversationFilters extends BrowserPageQuery {
  platform?: 'telegram' | 'qq' | 'web'
  userId?: string
  cli?: 'claude' | 'opencode'
  status?: 'idle' | 'starting' | 'running' | 'closing' | 'closed'
}

export function getConversations(query: ConversationFilters = {}): Promise<CursorPage<ConversationView>> {
  return requestJson(`/api/web/conversations?${toQuery(query)}`)
}

export function getConversation(id: ConversationId): Promise<ConversationDetail> {
  return requestJson(`/api/web/conversations/${encodeURIComponent(id)}`)
}

export function getConversationTimeline(id: ConversationId, query: BrowserPageQuery = {}): Promise<TimelinePage> {
  return requestJson(`/api/web/conversations/${encodeURIComponent(id)}/messages?${toQuery(query)}`)
}

export function getConversationFiles(id: ConversationId, query: BrowserPageQuery = {}): Promise<ConversationFilePage> {
  return requestJson(`/api/web/conversations/${encodeURIComponent(id)}/files?${toQuery(query)}`)
}

export function conversationFileUrl(id: ConversationId, fileId: string): string {
  return `/api/web/conversations/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`
}

export function deleteConversation(id: ConversationId): Promise<{ deletion: ConversationDeletionResult }> {
  return requestJson(`/api/web/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

function toQuery(query: object): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  return params.toString()
}
