import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FileTextExtractor, FileTextInput, FileTextResult } from '../shared'

const require = createRequire(import.meta.url)
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(MODULE_DIR, '../..')

const DOCX_EXTENSIONS = new Set(['.docx'])
const UNSUPPORTED_WORD_EXTENSIONS = new Set(['.doc'])

interface MammothMessage {
  message: string
}

interface MammothModule {
  extractRawText(input: { path: string }): Promise<{ value: string; messages: MammothMessage[] }>
}

function loadMammoth(): MammothModule {
  return requirePackage<MammothModule>('mammoth', 'lib/index.js')
}

function requirePackage<T>(name: string, entry: string): T {
  try {
    return require(name) as T
  } catch {
    return require(path.join(PROJECT_ROOT, 'node_modules', name, entry)) as T
  }
}

function extOf(input: FileTextInput): string {
  return path.extname(input.fileName ?? input.localPath).toLowerCase()
}

function mimeOf(input: FileTextInput): string {
  return input.mimeType?.toLowerCase() ?? ''
}

function isDocx(input: FileTextInput): boolean {
  return DOCX_EXTENSIONS.has(extOf(input)) || mimeOf(input).includes('wordprocessingml.document')
}

function isUnsupportedDoc(input: FileTextInput): boolean {
  return UNSUPPORTED_WORD_EXTENSIONS.has(extOf(input)) || mimeOf(input) === 'application/msword'
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim()
}

async function extractDocx(input: FileTextInput): Promise<FileTextResult> {
  try {
    const mammoth = loadMammoth()
    const result = await mammoth.extractRawText({ path: input.localPath })
    const text = normalizeText(result.value)
    const warnings = result.messages.map(message => message.message).filter(Boolean)
    if (!text) return { status: 'unsupported', reason: 'DOCX has no extractable text.' }
    return { status: 'ok', text, warnings }
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

export function createDefaultFileTextExtractor(): FileTextExtractor {
  return {
    extract(input: FileTextInput): Promise<FileTextResult> {
      if (isDocx(input)) return extractDocx(input)
      if (isUnsupportedDoc(input)) {
        return Promise.resolve({
          status: 'unsupported',
          reason: 'Legacy .doc files are not supported; please send .docx or export to PDF/text.',
        })
      }
      return Promise.resolve({ status: 'unsupported', reason: 'No text extractor is configured for this file type.' })
    },
  }
}
