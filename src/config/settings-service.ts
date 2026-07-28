import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SettingsJsonSchema, type SettingsJson } from './schema'

export interface SettingsService {
  read(): Promise<Record<string, unknown>>
  save(input: Record<string, unknown>): Promise<void>
}

const SENSITIVE_KEY = /(?:token|password|secret|apiKey)$/i

export function createSettingsService(settingsPath = 'settings.json'): SettingsService {
  async function readRaw(): Promise<SettingsJson> {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    const result = SettingsJsonSchema.safeParse(parsed)
    if (!result.success) throw new Error(formatIssues(result.error.issues))
    return result.data
  }

  return {
    async read() {
      return redact(await readRaw()) as Record<string, unknown>
    },
    async save(input) {
      const current = await readRaw()
      const candidate = restoreSecrets(input, current) as SettingsJson
      const result = SettingsJsonSchema.safeParse(candidate)
      if (!result.success) throw new Error(formatIssues(result.error.issues))
      const tempPath = `${settingsPath}.${crypto.randomUUID()}.tmp`
      await writeFile(tempPath, JSON.stringify(result.data, null, 2) + '\n', 'utf8')
      await rename(tempPath, path.resolve(settingsPath))
    },
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) && typeof item === 'string' && item ? { configured: true } : redact(item),
    ]),
  )
}

function restoreSecrets(input: unknown, current: unknown): unknown {
  if (Array.isArray(input))
    return input.map((item, index) => restoreSecrets(item, Array.isArray(current) ? current[index] : undefined))
  if (!input || typeof input !== 'object') return input
  const currentObject = current && typeof current === 'object' ? (current as Record<string, unknown>) : {}
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) && isConfiguredMarker(item)
        ? (currentObject[key] ?? '')
        : restoreSecrets(item, currentObject[key]),
    ]),
  )
}

function isConfiguredMarker(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { configured?: unknown }).configured === true)
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
}
