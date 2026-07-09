import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FileTextExtractor, FileTextInput, FileTextResult } from '../shared'

const require = createRequire(import.meta.url)
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(MODULE_DIR, '../..')

const EXCEL_EXTENSIONS = new Set(['.xls', '.xlsx'])
const DOCX_EXTENSIONS = new Set(['.docx'])
const UNSUPPORTED_WORD_EXTENSIONS = new Set(['.doc'])

interface MammothMessage {
  message: string
}

interface MammothModule {
  extractRawText(input: { path: string }): Promise<{ value: string; messages: MammothMessage[] }>
}

interface PdfParseTextResult {
  text: string
}

interface PdfParser {
  getText(): Promise<PdfParseTextResult>
  destroy(): Promise<void>
}

interface PdfParseModule {
  PDFParse: new (input: { data: Uint8Array }) => PdfParser
}

interface XlsxSheet {
  [key: string]: unknown
}

interface XlsxWorkbook {
  SheetNames: string[]
  Sheets: Record<string, XlsxSheet>
}

interface XlsxModule {
  read(data: Uint8Array, options: { type: 'buffer'; dense: true }): XlsxWorkbook
  utils: {
    sheet_to_csv(sheet: XlsxSheet, options: { blankrows: false }): string
  }
}

function loadMammoth(): MammothModule {
  return requirePackage<MammothModule>('mammoth', 'lib/index.js')
}

async function loadPdfParse(): Promise<PdfParseModule> {
  return (await import('pdf-parse')) as PdfParseModule
}

function loadXlsx(): XlsxModule {
  return requirePackage<XlsxModule>('xlsx', 'xlsx.js')
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

function isPdf(input: FileTextInput): boolean {
  return mimeOf(input) === 'application/pdf' || extOf(input) === '.pdf'
}

function isDocx(input: FileTextInput): boolean {
  return DOCX_EXTENSIONS.has(extOf(input)) || mimeOf(input).includes('wordprocessingml.document')
}

function isUnsupportedDoc(input: FileTextInput): boolean {
  return UNSUPPORTED_WORD_EXTENSIONS.has(extOf(input)) || mimeOf(input) === 'application/msword'
}

function isExcel(input: FileTextInput): boolean {
  const mime = mimeOf(input)
  return EXCEL_EXTENSIONS.has(extOf(input)) || mime.includes('spreadsheetml.sheet') || mime.includes('ms-excel')
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

async function extractPdf(input: FileTextInput): Promise<FileTextResult> {
  let parser: PdfParser | undefined
  try {
    const { PDFParse } = await loadPdfParse()
    const data = await readFile(input.localPath)
    parser = new PDFParse({ data })
    const result = await parser.getText()
    const text = normalizeText(result.text)
    if (!text) {
      return {
        status: 'unsupported',
        reason: 'PDF has no extractable text; OCR provider is required for scanned pages.',
      }
    }
    return { status: 'ok', text }
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  } finally {
    await parser?.destroy()
  }
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

async function extractExcel(input: FileTextInput): Promise<FileTextResult> {
  try {
    const { read, utils } = loadXlsx()
    const data = await readFile(input.localPath)
    const workbook = read(data, { type: 'buffer', dense: true })
    const sections: string[] = []
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet) continue
      const csv = normalizeText(utils.sheet_to_csv(sheet, { blankrows: false }))
      if (csv) sections.push(`Sheet: ${sheetName}\n${csv}`)
    }
    const text = sections.join('\n\n')
    if (!text) return { status: 'unsupported', reason: 'Spreadsheet has no extractable text.' }
    return { status: 'ok', text }
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

export function createDefaultFileTextExtractor(): FileTextExtractor {
  return {
    extract(input: FileTextInput): Promise<FileTextResult> {
      if (isPdf(input)) return extractPdf(input)
      if (isDocx(input)) return extractDocx(input)
      if (isExcel(input)) return extractExcel(input)
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
