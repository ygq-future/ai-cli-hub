import type {
  CliPreferenceUpdate,
  CliPreferenceView,
  CliType,
  CursorPage,
  PreferenceScope,
  PreferenceScopeView,
  PreferenceSnapshot,
  PreferenceUpdate,
} from '../../shared'
import { requestJson } from './http-client'
import { ADMIN_PAGE_SIZE, type BrowserPageQuery } from './types'

export function getPreferenceScopes(query: BrowserPageQuery = {}): Promise<CursorPage<PreferenceScopeView>> {
  return requestJson(`/api/web/preference-scopes?${toQuery(query)}`)
}

export function getPreferences(scope: PreferenceScope): Promise<PreferenceSnapshot> {
  return requestJson(`/api/web/preferences/${scope.platform}/${encodeURIComponent(scope.userId)}`)
}

export function updatePreferences(scope: PreferenceScope, input: PreferenceUpdate): Promise<PreferenceSnapshot> {
  return requestJson(`/api/web/preferences/${scope.platform}/${encodeURIComponent(scope.userId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function updateCliPreference(
  scope: PreferenceScope,
  cli: CliType,
  input: CliPreferenceUpdate,
): Promise<CliPreferenceView> {
  return requestJson(`/api/web/preferences/${scope.platform}/${encodeURIComponent(scope.userId)}/cli/${cli}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

function toQuery(query: BrowserPageQuery): string {
  const params = new URLSearchParams({ limit: String(ADMIN_PAGE_SIZE) })
  if (query.before) params.set('before', query.before)
  return params.toString()
}
