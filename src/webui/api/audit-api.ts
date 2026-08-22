import type { AuditPage, ApprovalStatus, CliType, Platform } from '../../shared'
import { requestJson } from './http-client'
import type { BrowserPageQuery } from './types'

export interface AuditFilters extends BrowserPageQuery {
  conversationId?: string
  platform?: Platform
  userId?: string
  cli?: CliType
  status?: ApprovalStatus
}

export function getAudits(query: AuditFilters = {}): Promise<AuditPage> {
  const params = new URLSearchParams({ limit: String(query.limit ?? 50) })
  if (query.before) params.set('before', query.before)
  if (query.conversationId) params.set('conversationId', query.conversationId)
  if (query.platform) params.set('platform', query.platform)
  if (query.userId) params.set('userId', query.userId)
  if (query.cli) params.set('cli', query.cli)
  if (query.status) params.set('status', query.status)
  return requestJson(`/api/web/audits?${params.toString()}`)
}
