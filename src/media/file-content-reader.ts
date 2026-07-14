import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  FileContentReader,
  FileContentResult,
  FileTextExtractor,
  OcrProvider,
  StoredFileReference,
} from '../shared'
import { createDefaultFileTextExtractor } from './file-text-extractor'
import { UNCONFIGURED_OCR_PROVIDER } from './ocr'

interface PdfDocument {
  length: number
  getPage(pageNumber: number): Promise<Buffer>
  destroy(): Promise<void>
}

export interface FileContentReaderOptions {
  maxTextChars: number
  maxPdfPages?: number
  pdfRenderScale?: number
  ocrProvider?: OcrProvider
  textExtractor?: FileTextExtractor
  pdfFactory?: (localPath: string, scale: number) => Promise<PdfDocument>
}

export function createFileContentReader(options: FileContentReaderOptions): FileContentReader {
  const extractor = options.textExtractor ?? createDefaultFileTextExtractor()
  const ocrProvider = options.ocrProvider ?? UNCONFIGURED_OCR_PROVIDER
  const maxPdfPages = options.maxPdfPages ?? 20
  const pdfRenderScale = options.pdfRenderScale ?? 2
  const pdfFactory =
    options.pdfFactory ??
    (async (localPath, scale) => {
      const { pdf } = await import('pdf-to-img')
      return pdf(localPath, { scale })
    })
  return {
    async read(file): Promise<FileContentResult> {
      const extension = path.extname(file.fileName ?? file.localPath).toLowerCase()
      if (extension === '.pdf' || file.mimeType === 'application/pdf') {
        return readPdf(file, {
          maxPdfPages,
          pdfRenderScale,
          maxTextChars: options.maxTextChars,
          ocrProvider,
          pdfFactory,
        })
      }
      if (isImage(file)) return readImage(file, ocrProvider, options.maxTextChars)
      if (['.xlsx', '.xls'].includes(extension)) {
        return { status: 'unsupported', reason: 'Excel files are not parsed; use @fileN to pass the path to the AI.' }
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

async function readImage(
  file: StoredFileReference,
  ocrProvider: OcrProvider,
  maxTextChars: number,
): Promise<FileContentResult> {
  const result = await ocrProvider.recognize({
    localPath: file.localPath,
    fileName: file.fileName ?? undefined,
    mimeType: file.mimeType ?? undefined,
  })
  if (result.status !== 'ok')
    return { status: result.status === 'failed' ? 'failed' : 'unsupported', reason: result.reason }
  return limitResult({ status: 'ok', text: result.text }, maxTextChars)
}

async function readPdf(
  file: StoredFileReference,
  options: Required<
    Pick<FileContentReaderOptions, 'maxPdfPages' | 'pdfRenderScale' | 'maxTextChars' | 'ocrProvider'>
  > & {
    pdfFactory: NonNullable<FileContentReaderOptions['pdfFactory']>
  },
): Promise<FileContentResult> {
  let document: PdfDocument | undefined
  let temporaryDirectory: string | undefined
  try {
    document = await options.pdfFactory(file.localPath, options.pdfRenderScale)
    const pageCount = Math.min(document.length, options.maxPdfPages)
    if (pageCount === 0) return { status: 'unsupported', reason: 'PDF contains no pages.' }
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-pdf-'))
    const sections: string[] = []
    const warnings: string[] = []
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const pagePath = path.join(temporaryDirectory, `page-${pageNumber}.png`)
      await writeFile(pagePath, await document.getPage(pageNumber))
      const result = await options.ocrProvider.recognize({
        localPath: pagePath,
        mimeType: 'image/png',
        fileName: `page-${pageNumber}.png`,
      })
      if (result.status === 'ok') sections.push(`[Page ${pageNumber}]\n${result.text.trim() || '[no text]'}`)
      else warnings.push(`Page ${pageNumber} OCR ${result.status}: ${result.reason}`)
    }
    if (document.length > pageCount) warnings.push(`PDF limited to the first ${pageCount} of ${document.length} pages.`)
    if (sections.length === 0) {
      return { status: 'failed', reason: warnings.join('; ') || 'PDF OCR produced no readable text.' }
    }
    return limitResult({ status: 'ok', text: sections.join('\n\n'), warnings }, options.maxTextChars)
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  } finally {
    await document?.destroy().catch(() => {})
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

function isImage(file: StoredFileReference): boolean {
  if (file.kind === 'photo' || file.mimeType?.toLowerCase().startsWith('image/')) return true
  return /\.(?:png|jpe?g|webp|bmp|tiff?)$/i.test(file.fileName ?? file.localPath)
}

async function readPlainText(localPath: string, maxTextChars: number): Promise<FileContentResult> {
  try {
    const bytes = await readFile(localPath)
    const text = decodeText(bytes)
    if (text === null) return { status: 'unsupported', reason: 'File appears to be binary, not readable text.' }
    if (!text) return { status: 'unsupported', reason: 'File contains no readable text.' }
    return limitResult({ status: 'ok', text }, maxTextChars)
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return Buffer.from(bytes.slice(2)).toString('utf16le').trim()
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const source = bytes.slice(2)
      const swapped = new Uint8Array(source.length)
      for (let index = 0; index + 1 < source.length; index += 2) {
        swapped[index] = source[index + 1] ?? 0
        swapped[index + 1] = source[index] ?? 0
      }
      return Buffer.from(swapped).toString('utf16le').trim()
    }
    if (bytes.includes(0)) return null
    const text = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, '')
      .trim()
    const controlCount = [...text].filter(char => char < ' ' && !['\n', '\r', '\t'].includes(char)).length
    return text.length > 0 && controlCount / text.length > 0.02 ? null : text
  } catch {
    return null
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
