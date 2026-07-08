import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createDefaultFileTextExtractor } from './file-text-extractor'

describe('createDefaultFileTextExtractor', () => {
  test('提取 DOCX 原始文本', async () => {
    const extractor = createDefaultFileTextExtractor()
    const result = await extractor.extract({
      localPath: 'node_modules/mammoth/test/test-data/single-paragraph.docx',
      fileName: 'single-paragraph.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' ? result.text.length : 0).toBeGreaterThan(0)
  })

  test('提取 XLS 工作表为 CSV 文本', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-xls-'))
    try {
      const file = path.join(dir, 'book.xls')
      await writeFile(file, 'name,count\napples,3')

      const extractor = createDefaultFileTextExtractor()
      const result = await extractor.extract({
        localPath: file,
        fileName: 'book.xls',
        mimeType: 'application/vnd.ms-excel',
      })

      expect(result.status).toBe('ok')
      expect(result.status === 'ok' ? result.text : '').toContain('Sheet: Sheet1')
      expect(result.status === 'ok' ? result.text : '').toContain('apples,3')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('旧 .doc 返回明确不支持', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-doc-'))
    try {
      const file = path.join(dir, 'legacy.doc')
      await writeFile(file, 'legacy content')
      const extractor = createDefaultFileTextExtractor()
      const result = await extractor.extract({
        localPath: file,
        fileName: 'legacy.doc',
        mimeType: 'application/msword',
      })

      expect(result).toEqual({
        status: 'unsupported',
        reason: 'Legacy .doc files are not supported; please send .docx or export to PDF/text.',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('PDF 无可提取文本时返回 unsupported，供 OCR 抽象兜底', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-pdf-'))
    try {
      const file = path.join(dir, 'empty.pdf')
      await copyFile('node_modules/mammoth/test/test-data/empty.docx', file)
      const extractor = createDefaultFileTextExtractor()
      const result = await extractor.extract({
        localPath: file,
        fileName: 'empty.pdf',
        mimeType: 'application/pdf',
      })

      expect(['unsupported', 'failed']).toContain(result.status)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
