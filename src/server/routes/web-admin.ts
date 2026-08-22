import type {
  AuditListQuery,
  CliPreferenceUpdate,
  CliType,
  ConversationId,
  ConversationListQuery,
  MemoryListQuery,
  MemoryUpdate,
  Platform,
  PreferenceScope,
  PreferenceUpdate,
  WebAdmin,
} from '../../shared'
import { WebAdminError } from '../../web-admin'
import {
  decodeComponent,
  jsonResponse,
  methodNotAllowed,
  optionalBoolean,
  optionalNullableString,
  optionalNumber,
  optionalString,
  parsePageQuery,
  readJsonObject,
  requiredPathId,
  RequestValidationError,
} from '../request'

const ADMIN_PATH_PREFIXES = [
  '/api/web/conversations',
  '/api/web/preference-scopes',
  '/api/web/preferences',
  '/api/web/memories',
  '/api/web/audits',
] as const

export function isWebAdminPath(pathname: string): boolean {
  return ADMIN_PATH_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export async function handleWebAdminRequest(
  request: Request,
  url: URL,
  admin: WebAdmin,
  maxRequestBodyBytes: number,
): Promise<Response> {
  try {
    if (url.pathname === '/api/web/conversations' || url.pathname.startsWith('/api/web/conversations/'))
      return await handleConversations(request, url, admin)
    if (url.pathname === '/api/web/preference-scopes') return await handlePreferenceScopes(request, url, admin)
    if (url.pathname === '/api/web/preferences' || url.pathname.startsWith('/api/web/preferences/'))
      return await handlePreferences(request, url, admin, maxRequestBodyBytes)
    if (url.pathname === '/api/web/memories' || url.pathname.startsWith('/api/web/memories/'))
      return await handleMemories(request, url, admin, maxRequestBodyBytes)
    if (url.pathname === '/api/web/audits') return await handleAudits(request, url, admin)
    return jsonResponse({ error: 'Not found' }, 404)
  } catch (error) {
    if (error instanceof RequestValidationError) return jsonResponse({ error: error.message }, 400)
    if (error instanceof WebAdminError) return jsonResponse({ error: error.message }, statusForAdminError(error))
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}

async function handleConversations(request: Request, url: URL, admin: WebAdmin): Promise<Response> {
  const segments = pathSegments(url.pathname, '/api/web/conversations')
  if (segments.length === 0) {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    const page = parsePageQuery(url)
    const query: ConversationListQuery = {
      ...page,
      platform: optionalEnum(url.searchParams.get('platform'), 'platform', ['telegram', 'qq', 'web']),
      userId: optionalQueryString(url.searchParams.get('userId'), 'userId'),
      cli: optionalEnum(url.searchParams.get('cli'), 'cli', ['claude', 'opencode']),
      status: optionalEnum(url.searchParams.get('status'), 'status', [
        'idle',
        'starting',
        'running',
        'closing',
        'closed',
      ]),
    }
    return jsonResponse(await admin.listConversations(query))
  }

  const conversationId = requiredPathId(segments[0], 'conversationId') as ConversationId
  if (segments.length === 1) {
    if (request.method === 'GET') return notFoundOrJson(await admin.getConversation(conversationId))
    if (request.method === 'DELETE') {
      const result = await admin.deleteConversation(conversationId)
      return result ? jsonResponse({ deletion: result }) : jsonResponse({ error: 'Not found' }, 404)
    }
    return methodNotAllowed('GET, DELETE')
  }
  if (segments[1] === 'messages' && segments.length === 2) {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    return notFoundOrJson(await admin.getConversationTimeline(conversationId, parsePageQuery(url)))
  }
  if (segments[1] === 'files' && segments.length === 2) {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    return notFoundOrJson(await admin.getConversationFiles(conversationId, parsePageQuery(url)))
  }
  if (segments[1] === 'files' && segments.length === 3) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
    const fileId = requiredPathId(segments[2], 'fileId')
    const file = await admin.getConversationFile(conversationId, fileId)
    if (!file) return jsonResponse({ error: 'Not found' }, 404)
    const headers = new Headers({ 'content-type': file.mimeType ?? 'application/octet-stream' })
    if (file.fileName)
      headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
    return new Response(request.method === 'HEAD' ? null : file.body, { headers })
  }
  return jsonResponse({ error: 'Not found' }, 404)
}

async function handlePreferenceScopes(request: Request, url: URL, admin: WebAdmin): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET')
  return jsonResponse(await admin.listPreferenceScopes(parsePageQuery(url)))
}

async function handlePreferences(
  request: Request,
  url: URL,
  admin: WebAdmin,
  maxRequestBodyBytes: number,
): Promise<Response> {
  const segments = pathSegments(url.pathname, '/api/web/preferences')
  if (segments.length !== 2 && segments.length !== 4) return jsonResponse({ error: 'Not found' }, 404)
  const platform = requiredPlatform(segments[0])
  const scope: PreferenceScope = { platform, userId: requiredPathId(segments[1], 'userId') }
  if (segments.length === 2) {
    if (request.method === 'GET') return jsonResponse(await admin.getPreferences(scope))
    if (request.method !== 'PUT') return methodNotAllowed('GET, PUT')
    const body = await readJsonObject(request, maxRequestBodyBytes)
    const input: PreferenceUpdate = {
      language: optionalEnum(body.language, 'language', ['zh', 'en']),
      defaultCli: optionalEnum(body.defaultCli, 'defaultCli', ['claude', 'opencode']),
      autoApproveEnabled: optionalBoolean(body, 'autoApproveEnabled'),
      autoApproveSeconds: optionalNumber(body, 'autoApproveSeconds'),
    }
    return jsonResponse(await admin.updatePreferences(scope, input))
  }
  if (segments[2] !== 'cli') return jsonResponse({ error: 'Not found' }, 404)
  if (request.method !== 'PUT') return methodNotAllowed('PUT')
  const cli = optionalEnum(segments[3], 'cli', ['claude', 'opencode']) as CliType
  const body = await readJsonObject(request, maxRequestBodyBytes)
  const input: CliPreferenceUpdate = {
    cwd: optionalString(body, 'cwd'),
    modelId: optionalNullableString(body, 'modelId'),
    modelName: optionalNullableString(body, 'modelName'),
  }
  return jsonResponse(await admin.updateCliPreference(scope, cli, input))
}

async function handleMemories(
  request: Request,
  url: URL,
  admin: WebAdmin,
  maxRequestBodyBytes: number,
): Promise<Response> {
  const segments = pathSegments(url.pathname, '/api/web/memories')
  if (segments.length === 0) {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    const page = parsePageQuery(url)
    const query: MemoryListQuery = {
      ...page,
      type: optionalEnum(url.searchParams.get('type'), 'type', ['episodic', 'semantic', 'preference']),
      search: optionalQueryString(url.searchParams.get('search'), 'search'),
    }
    return jsonResponse(await admin.listMemories(query))
  }
  if (segments.length === 2 && segments[0] === 'environment' && segments[1] === 'refresh') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    await admin.refreshEnvironmentMemories()
    return jsonResponse({ refreshed: true })
  }
  if (segments.length !== 1) return jsonResponse({ error: 'Not found' }, 404)
  const memoryId = requiredPathId(segments[0], 'memoryId')
  if (request.method === 'PATCH') {
    const body = await readJsonObject(request, maxRequestBodyBytes)
    const input: MemoryUpdate = {
      content: optionalString(body, 'content'),
      type: optionalEnum(body.type, 'type', ['episodic', 'semantic', 'preference']),
      importance: optionalNumber(body, 'importance'),
    }
    return notFoundOrJson(await admin.updateMemory(memoryId, input))
  }
  if (request.method === 'DELETE') {
    const result = await admin.deleteMemory(memoryId)
    if (result === 'not_found') return jsonResponse({ error: 'Not found' }, 404)
    if (result === 'read_only') return jsonResponse({ error: 'Memory is read-only' }, 403)
    return jsonResponse({ deleted: true })
  }
  return methodNotAllowed('PATCH, DELETE')
}

async function handleAudits(request: Request, url: URL, admin: WebAdmin): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET')
  const page = parsePageQuery(url)
  const query: AuditListQuery = {
    ...page,
    conversationId: optionalQueryString(url.searchParams.get('conversationId'), 'conversationId') as
      ConversationId | undefined,
    platform: optionalEnum(url.searchParams.get('platform'), 'platform', ['telegram', 'qq', 'web']),
    userId: optionalQueryString(url.searchParams.get('userId'), 'userId'),
    cli: optionalEnum(url.searchParams.get('cli'), 'cli', ['claude', 'opencode']),
    status: optionalEnum(url.searchParams.get('status'), 'status', ['pending', 'approved', 'rejected']),
  }
  return jsonResponse(await admin.listAudits(query))
}

function pathSegments(pathname: string, prefix: string): string[] {
  if (pathname === prefix) return []
  if (!pathname.startsWith(`${prefix}/`)) return []
  return pathname
    .slice(prefix.length + 1)
    .split('/')
    .map(decodeComponent)
}

function requiredPlatform(value: string | undefined): Platform {
  return optionalEnum(value, 'platform', ['telegram', 'qq', 'web']) as Platform
}

function optionalQueryString(value: string | null, name: string): string | undefined {
  if (value === null) return undefined
  return requiredPathId(value, name)
}

function optionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new RequestValidationError(`${name} is invalid`)
  return value as T
}

function notFoundOrJson(value: unknown): Response {
  return value === null ? jsonResponse({ error: 'Not found' }, 404) : jsonResponse(value)
}

function statusForAdminError(error: WebAdminError): number {
  if (error.code === 'bad_request') return 400
  if (error.code === 'forbidden') return 403
  if (error.code === 'not_found') return 404
  return 409
}
