import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createFileContentReader } from './file-content-reader'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function temporaryFile(name: string, content: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-reader-'))
  temporaryDirectories.push(directory)
  const localPath = path.join(directory, name)
  await writeFile(localPath, content)
  return localPath
}

describe('file content reader', () => {
  test('PDF 按页渲染并循环 OCR，超过上限时给出警告且销毁文档', async () => {
    const localPath = await temporaryFile('sample.pdf', 'fake pdf')
    const recognizedPaths: string[] = []
    let destroyed = false
    const reader = createFileContentReader({
      maxTextChars: 20_000,
      maxPdfPages: 2,
      ocrProvider: {
        async recognize(input) {
          recognizedPaths.push(input.localPath)
          return { status: 'ok', text: `text from ${path.basename(input.localPath)}` }
        },
      },
      pdfFactory: async () => ({
        length: 3,
        async getPage(pageNumber) {
          return Buffer.from(`page ${pageNumber}`)
        },
        async destroy() {
          destroyed = true
        },
      }),
    })

    const result = await reader.read({
      sequence: 1,
      kind: 'document',
      fileName: 'sample.pdf',
      mimeType: 'application/pdf',
      localPath,
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected readable PDF')
    expect(result.text).toContain('[Page 1]')
    expect(result.text).toContain('[Page 2]')
    expect(result.warnings).toContain('PDF limited to the first 2 of 3 pages.')
    expect(recognizedPaths).toHaveLength(2)
    expect(destroyed).toBe(true)
    expect(await Bun.file(path.dirname(recognizedPaths[0]!)).exists()).toBe(false)
  })

  test('图片通过 @read 读取时复用 OCR provider', async () => {
    const localPath = await temporaryFile('image.png', 'image')
    const reader = createFileContentReader({
      maxTextChars: 100,
      ocrProvider: {
        async recognize() {
          return { status: 'ok', text: '图片文字' }
        },
      },
    })
    expect(
      await reader.read({ sequence: 1, kind: 'photo', fileName: 'image.png', mimeType: 'image/png', localPath }),
    ).toEqual({ status: 'ok', text: '图片文字' })
  })

  test('无常见后缀的 UTF-16 文本可以识别，Excel 明确保持不解析', async () => {
    const utf16Path = await temporaryFile('unknown.bin', Buffer.from(`\uFEFF未命名文本`, 'utf16le'))
    const excelPath = await temporaryFile('sheet.xlsx', 'fake')
    const reader = createFileContentReader({ maxTextChars: 100 })

    expect(
      await reader.read({
        sequence: 1,
        kind: 'document',
        fileName: 'unknown.bin',
        mimeType: null,
        localPath: utf16Path,
      }),
    ).toEqual({ status: 'ok', text: '未命名文本' })
    const excel = await reader.read({
      sequence: 2,
      kind: 'document',
      fileName: 'sheet.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      localPath: excelPath,
    })
    expect(excel.status).toBe('unsupported')
    if (excel.status === 'unsupported') expect(excel.reason).toContain('Excel files are not parsed')
  })
})
