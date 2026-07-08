import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createMediaPreprocessor, normalizeEmojis } from './index'

describe('normalizeEmojis', () => {
  test('识别 Unicode emoji 并补充语义', () => {
    expect(normalizeEmojis('今天好累 😭')).toEqual([
      {
        emoji: '😭',
        name: 'loudly crying face',
        keywords: ['crying', 'sad', 'overwhelmed'],
      },
    ])
  })
})

describe('createMediaPreprocessor', () => {
  test('把 emoji 和 sticker metadata 拼入上下文', async () => {
    const preprocessor = createMediaPreprocessor({ maxTextChars: 1000 })
    const result = await preprocessor.preprocess({
      text: '今天好累 😭',
      stickers: [
        {
          emoji: '👍',
          setName: 'ok_set',
          isAnimated: false,
          isVideo: false,
          fileId: 'sf1',
        },
      ],
    })

    expect(result.text).toContain('Emoji context:')
    expect(result.text).toContain('loudly crying face')
    expect(result.text).toContain('Telegram sticker metadata:')
    expect(result.text).toContain('set_name=ok_set')
    expect(result.text).toContain('Sticker visual understanding is deferred')
  })

  test('非图片文本附件只保存 metadata，不自动读取内容', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-media-'))
    try {
      const file = path.join(dir, 'note.txt')
      await writeFile(file, 'abcdef')
      const preprocessor = createMediaPreprocessor({ maxTextChars: 3 })
      const result = await preprocessor.preprocess({
        text: '看文件',
        attachments: [
          {
            kind: 'document',
            fileId: 'f1',
            fileName: 'note.txt',
            mimeType: 'text/plain',
            localPath: file,
          },
        ],
      })

      expect(result.text).toContain('[File preprocessing context]')
      expect(result.text).toContain('Current message file/attachment context:')
      expect(result.text).toContain('Non-image files are saved only')
      expect(result.text).toContain('content_status: saved_only_lazy_load')
      expect(result.text).toContain('local_path=')
      expect(result.text).not.toContain('extracted_text:')
      expect(result.text).not.toContain('abc')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('图片附件调用 OCR 抽象接口；未配置实现时返回占位状态', async () => {
    const preprocessor = createMediaPreprocessor({ maxTextChars: 1000 })
    const result = await preprocessor.preprocess({
      text: '识别图片',
      attachments: [
        {
          kind: 'photo',
          fileId: 'p1',
          mimeType: 'image/jpeg',
          localPath: 'D:/media/p1.jpg',
        },
      ],
    })

    expect(result.text).toContain('ocr_status: OCR unavailable: OCR provider is not configured yet.')
    expect(result.warnings).toEqual(['OCR unavailable: OCR provider is not configured yet.'])
  })

  test('PDF 上传时懒加载，不自动提取文本或 OCR', async () => {
    const preprocessor = createMediaPreprocessor({
      maxTextChars: 1000,
      ocrProvider: {
        async recognize() {
          throw new Error('OCR should not be called for PDF upload')
        },
      },
    })

    const result = await preprocessor.preprocess({
      text: '看 PDF',
      attachments: [
        {
          kind: 'document',
          fileId: 'pdf1',
          fileName: 'scan.pdf',
          mimeType: 'application/pdf',
          localPath: 'D:/media/scan.pdf',
        },
      ],
    })

    expect(result.text).toContain('content_status: saved_only_lazy_load')
    expect(result.text).not.toContain('parse_status:')
    expect(result.text).not.toContain('ocr_text:')
  })

  test('Office 附件上传时懒加载，不自动提取文本', async () => {
    const preprocessor = createMediaPreprocessor({
      maxTextChars: 1000,
    })

    const result = await preprocessor.preprocess({
      text: '看 Word',
      attachments: [
        {
          kind: 'document',
          fileId: 'doc1',
          fileName: 'report.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          localPath: 'D:/media/report.docx',
        },
      ],
    })

    expect(result.text).toContain('content_status: saved_only_lazy_load')
    expect(result.text).not.toContain('extracted_text:')
    expect(result.text).not.toContain('office body text')
  })

  test('可注入具体 OCR provider', async () => {
    const preprocessor = createMediaPreprocessor({
      maxTextChars: 1000,
      ocrProvider: {
        async recognize() {
          return { status: 'ok', text: 'hello from image' }
        },
      },
    })

    const result = await preprocessor.preprocess({
      text: '识别图片',
      attachments: [
        {
          kind: 'photo',
          fileId: 'p1',
          mimeType: 'image/jpeg',
          localPath: 'D:/media/p1.jpg',
        },
      ],
    })

    expect(result.text).toContain('ocr_text:')
    expect(result.text).toContain('hello from image')
  })
})
