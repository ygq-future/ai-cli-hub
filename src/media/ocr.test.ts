import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createLightOcrProvider } from './ocr'

async function withTempFile<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-ocr-'))
  try {
    const file = path.join(dir, 'sample.png')
    await writeFile(file, new Uint8Array([1, 2, 3]))
    return await fn(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('createLightOcrProvider', () => {
  test('baseUrl 为空时返回未配置状态', async () => {
    const provider = createLightOcrProvider({ baseUrl: '', timeoutMs: 1000 })
    const result = await provider.recognize({ localPath: 'D:/missing.png' })
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'OCR provider is not configured yet.',
    })
  })

  test('按 Light OCR /ocr/file 契约上传文件并解析 text/lines', async () => {
    await withTempFile(async file => {
      let capturedUrl = ''
      let capturedMethod: string | undefined
      let capturedBody: unknown
      const fetchFn = async (input: string, init: RequestInit): Promise<Response> => {
        capturedUrl = input.toString()
        capturedMethod = init?.method
        capturedBody = init?.body
        return new Response(
          JSON.stringify({
            text: '你好\n世界',
            lines: [
              {
                text: '你好',
                score: 0.9876,
                box: [
                  [10, 20],
                  [100, 20],
                  [100, 50],
                  [10, 50],
                ],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      const provider = createLightOcrProvider({
        baseUrl: 'http://localhost:8000',
        timeoutMs: 1000,
        fetchFn,
      })
      const result = await provider.recognize({
        localPath: file,
        mimeType: 'image/png',
        fileName: 'sample.png',
      })

      expect(capturedUrl).toBe('http://localhost:8000/ocr/file')
      expect(capturedMethod).toBe('POST')
      expect(capturedBody).toBeInstanceOf(FormData)
      expect(result).toEqual({
        status: 'ok',
        text: '你好\n世界',
        lines: [
          {
            text: '你好',
            score: 0.9876,
            box: [
              [10, 20],
              [100, 20],
              [100, 50],
              [10, 50],
            ],
          },
        ],
      })
    })
  })

  test('HTTP 非 2xx 响应转为 failed', async () => {
    await withTempFile(async file => {
      const fetchFn = async (): Promise<Response> => new Response('bad image', { status: 500 })
      const provider = createLightOcrProvider({
        baseUrl: 'http://localhost:8000/',
        timeoutMs: 1000,
        fetchFn,
      })

      const result = await provider.recognize({ localPath: file })
      expect(result.status).toBe('failed')
      if (result.status === 'failed') expect(result.reason).toContain('HTTP 500: bad image')
    })
  })

  test('响应结构不符合契约时转为 failed', async () => {
    await withTempFile(async file => {
      const fetchFn = async (): Promise<Response> =>
        new Response(JSON.stringify({ text: 'hello', lines: [{ text: 'hello', score: 'bad', box: [] }] }), {
          status: 200,
        })
      const provider = createLightOcrProvider({
        baseUrl: 'http://localhost:8000',
        timeoutMs: 1000,
        fetchFn,
      })

      const result = await provider.recognize({ localPath: file })
      expect(result).toEqual({
        status: 'failed',
        reason: 'OCR API returned an invalid response shape.',
      })
    })
  })
})
