import type { MemoryPage, MemoryUpdate, MemoryView, MemoryType } from '../../shared'
import { requestJson } from './http-client'
import type { BrowserPageQuery } from './types'

export interface MemoryFilters extends BrowserPageQuery {
  type?: MemoryType
  search?: string
}

export function getMemories(query: MemoryFilters = {}): Promise<MemoryPage> {
  const params = new URLSearchParams({ limit: String(query.limit ?? 50) })
  if (query.before) params.set('before', query.before)
  if (query.type) params.set('type', query.type)
  if (query.search) params.set('search', query.search)
  return requestJson(`/api/web/memories?${params.toString()}`)
}

export function updateMemory(id: string, input: MemoryUpdate): Promise<MemoryView> {
  return requestJson(`/api/web/memories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function deleteMemory(id: string): Promise<{ deleted: true }> {
  return requestJson(`/api/web/memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function refreshEnvironmentMemories(): Promise<{ refreshed: true }> {
  return requestJson('/api/web/memories/environment/refresh', { method: 'POST' })
}
