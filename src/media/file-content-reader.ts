import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FileContentReader, FileContentResult, FileTextExtractor } from '../shared'
import { createDefaultFileTextExtractor } from './file-text-extractor'

export interface FileContentReaderOptions {
  maxTextChars: number
  textExtractor?: FileTextExtractor
}

export function createFileContentReader(options: FileContentReaderOptions): FileContentReader {
  const extractor = options.textExtractor ?? createDefaultFileTextExtractor()
  return {
    async read(file): Promise<FileContentResult> {
      const extension = path.extname(file.fileName ?? file.localPath).toLowerCase()
      if (extension === '.pdf' || file.mimeType === 'application/pdf') {
        return { status: 'unsupported', reason: 'PDF image rendering is not configured yet.' }
      }
      const extracted = await extractor.extract({
        localPath: file.localPath,
        fileName: file.fileName ?? undefined,
        mimeType: file.mimeType ?? undefined,
      })
      if (extracted.status === 'ok') return limitResult(extracted, options.maxTextChars)
      if (extracted.status === 'failed') return extracted
      return readPlainText(file.localPath, options.maxTextChars)
    },
  }
}

async function readPlainText(localPath: string, maxTextChars: number): Promise<FileContentResult> {
  try {
    const bytes = await readFile(localPath)
    if (bytes.includes(0)) return { status: 'unsupported', reason: 'File appears to be binary, not readable text.' }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    if (!text) return { status: 'unsupported', reason: 'File contains no readable text.' }
    return limitResult({ status: 'ok', text }, maxTextChars)
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

function limitResult(result: Extract<FileContentResult, { status: 'ok' }>, maxTextChars: number): FileContentResult {
  if (result.text.length <= maxTextChars) return result
  return {
    status: 'ok',
    text: `${result.text.slice(0, maxTextChars)}\n...[truncated ${result.text.length - maxTextChars} chars]`,
    warnings: [...(result.warnings ?? []), `Content truncated to ${maxTextChars} characters.`],
  }
}
