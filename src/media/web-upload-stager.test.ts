import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWebUploadStager, type WebUploadStager } from './web-upload-stager'

const roots: string[] = []
const stagers: WebUploadStager[] = []

afterEach(async () => {
  await Promise.all(stagers.splice(0).map(stager => stager.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(
  options: {
    maxBytes?: number
    maxFiles?: number
    maxTotalBytes?: number
    ttlMs?: number
    now?: () => number
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-upload-'))
  roots.push(directory)
  const stager = createWebUploadStager({
    directory,
    maxBytes: options.maxBytes ?? 10,
    maxFiles: options.maxFiles,
    maxTotalBytes: options.maxTotalBytes,
    ttlMs: options.ttlMs,
    now: options.now,
  })
  stagers.push(stager)
  return { directory, stager }
}

describe('WebUploadStager', () => {
  test('stages in an isolated directory and moves the file on consume', async () => {
    const { directory, stager } = await fixture()
    await stager.initialize()

    const upload = await stager.stage(new File(['image'], '../photo.png', { type: 'image/png' }))
    const stagingFiles = await readdir(path.join(directory, '.staging'))
    expect(upload.name).toBe('photo.png')
    expect(stagingFiles).toHaveLength(1)

    const attachments = await stager.consume([upload.id])
    expect(attachments).toEqual([
      expect.objectContaining({
        kind: 'photo',
        fileId: upload.id,
        fileName: 'photo.png',
        fileSize: 5,
      }),
    ])
    expect(attachments[0]!.localPath).not.toContain(`${path.sep}.staging${path.sep}`)
    expect(await Bun.file(attachments[0]!.localPath).exists()).toBe(true)
    expect(await readdir(path.join(directory, '.staging'))).toEqual([])
  })

  test('expires staged uploads and rejects them without leaving files', async () => {
    let currentTime = 1_000
    const { directory, stager } = await fixture({ ttlMs: 100, now: () => currentTime })
    await stager.initialize()
    const upload = await stager.stage(new File(['old'], 'old.txt'))

    currentTime = 1_101
    await expect(stager.consume([upload.id])).rejects.toThrow('unavailable')
    expect(await readdir(path.join(directory, '.staging'))).toEqual([])
  })

  test('enforces staged file count and total byte quotas', async () => {
    const count = await fixture({ maxFiles: 2, maxTotalBytes: 10 })
    await count.stager.initialize()
    await count.stager.stage(new File(['a'], 'a.txt'))
    await count.stager.stage(new File(['b'], 'b.txt'))
    await expect(count.stager.stage(new File(['c'], 'c.txt'))).rejects.toThrow('Too many staged uploads')

    const bytes = await fixture({ maxFiles: 10, maxTotalBytes: 3 })
    await bytes.stager.initialize()
    await bytes.stager.stage(new File(['ab'], 'ab.txt'))
    await expect(bytes.stager.stage(new File(['cd'], 'cd.txt'))).rejects.toThrow('staged upload size limit')
  })

  test('validates an entire consume batch before moving files and removes startup orphans', async () => {
    const { directory, stager } = await fixture()
    const stagingDirectory = path.join(directory, '.staging')
    await mkdir(stagingDirectory, { recursive: true })
    await writeFile(path.join(stagingDirectory, 'orphan.txt'), 'orphan')
    await stager.initialize()
    expect(await readdir(stagingDirectory)).toEqual([])

    const upload = await stager.stage(new File(['safe'], 'safe.txt'))
    await expect(stager.consume([upload.id, 'missing'])).rejects.toThrow('unavailable')
    expect(await readdir(stagingDirectory)).toHaveLength(1)
    expect((await stager.consume([upload.id]))[0]?.fileName).toBe('safe.txt')
  })
})
