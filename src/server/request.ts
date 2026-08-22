import type { CursorPageQuery, CursorPosition } from '../shared'

export const DEFAULT_ADMIN_PAGE_LIMIT = 50
export const MAX_ADMIN_PAGE_LIMIT = 100

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestValidationError'
  }
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers })
}

export function methodNotAllowed(allow: string): Response {
  return jsonResponse({ error: 'Method not allowed' }, 405, { allow })
}

export function parsePageQuery(url: URL): CursorPageQuery {
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? DEFAULT_ADMIN_PAGE_LIMIT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ADMIN_PAGE_LIMIT)
    throw new RequestValidationError(`limit must be between 1 and ${MAX_ADMIN_PAGE_LIMIT}`)
  const rawBefore = url.searchParams.get('before')
  return { limit, before: rawBefore === null ? undefined : parseCursor(rawBefore) }
}

export function parseCursor(raw: string): CursorPosition {
  const separator = raw.indexOf(':')
  if (separator <= 0 || separator === raw.length - 1) throw new RequestValidationError('Invalid cursor')
  const timestamp = Number(raw.slice(0, separator))
  const id = decodeComponent(raw.slice(separator + 1))
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !id || id.includes('/') || id.includes('\\'))
    throw new RequestValidationError('Invalid cursor')
  return { timestamp, id }
}

export async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null && Number.isFinite(Number(contentLength)) && Number(contentLength) > maxBytes)
    throw new RequestValidationError('Request body is too large')
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new RequestValidationError('Request body is too large')
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new RequestValidationError('Request body must be valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RequestValidationError('Request body must be a JSON object')
  return value as Record<string, unknown>
}

export function requiredPathId(value: string | undefined, name: string): string {
  if (!value || !value.trim() || value.length > 256 || value.includes('/') || value.includes('\\'))
    throw new RequestValidationError(`${name} must be a valid identifier`)
  return value
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new RequestValidationError(`${key} must be a string`)
  return value
}

export function optionalNullableString(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (value !== null && typeof value !== 'string') throw new RequestValidationError(`${key} must be a string or null`)
  return value
}

export function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new RequestValidationError(`${key} must be a boolean`)
  return value
}

export function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RequestValidationError(`${key} must be a number`)
  return value
}

export function decodeComponent(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new RequestValidationError('Invalid URL encoding')
  }
}
