import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { OcrBox, OcrLine, OcrProvider, OcrResult } from '../shared'

type LightOcrFetch = (input: string, init: RequestInit) => Promise<Response>

export const UNCONFIGURED_OCR_PROVIDER: OcrProvider = {
  recognize(): Promise<OcrResult> {
    return Promise.resolve({
      status: 'unavailable',
      reason: 'OCR provider is not configured yet.',
    })
  },
}

export interface LightOcrProviderOptions {
  baseUrl: string
  timeoutMs: number
  fetchFn?: LightOcrFetch
}

interface LightOcrLineResponse {
  text: string
  score: number
  box: OcrBox
}

interface LightOcrResponse {
  text: string
  lines: LightOcrLineResponse[]
}

function isPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'number')
}

function isBox(value: unknown): value is OcrBox {
  return Array.isArray(value) && value.length === 4 && value.every(isPoint)
}

function parseOcrResponse(value: unknown): LightOcrResponse | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.text !== 'string' || !Array.isArray(record.lines)) return null

  const lines: OcrLine[] = []
  for (const line of record.lines) {
    if (!line || typeof line !== 'object') return null
    const item = line as Record<string, unknown>
    if (typeof item.text !== 'string' || typeof item.score !== 'number' || !isBox(item.box)) return null
    lines.push({ text: item.text, score: item.score, box: item.box })
  }

  return { text: record.text, lines }
}

function joinUrl(baseUrl: string, pathname: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(pathname.replace(/^\//, ''), base).toString()
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`OCR request timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createLightOcrProvider(options: LightOcrProviderOptions): OcrProvider {
  const fetchImpl = options.fetchFn ?? fetch
  const baseUrl = options.baseUrl.trim()

  if (!baseUrl) return UNCONFIGURED_OCR_PROVIDER

  return {
    async recognize(input): Promise<OcrResult> {
      try {
        const bytes = await readFile(input.localPath)
        const fileName = input.fileName?.trim() || path.basename(input.localPath) || 'image'
        const form = new FormData()
        form.set('file', new Blob([bytes], { type: input.mimeType || 'application/octet-stream' }), fileName)

        const response = await withTimeout(
          fetchImpl(joinUrl(baseUrl, '/ocr/file'), { method: 'POST', body: form }),
          options.timeoutMs,
        )
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          return {
            status: 'failed',
            reason: `OCR API returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          }
        }

        const parsed = parseOcrResponse(await response.json())
        if (!parsed) return { status: 'failed', reason: 'OCR API returned an invalid response shape.' }
        return { status: 'ok', text: parsed.text, lines: parsed.lines }
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
