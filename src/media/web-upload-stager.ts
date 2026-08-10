import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { InboundAttachment } from '../shared'

const DEFAULT_MAX_FILES = 20
const DEFAULT_TTL_MS = 15 * 60 * 1000

export interface WebUploadStager {
  initialize(): Promise<void>
  stage(file: File): Promise<{ id: string; name: string; mimeType: string; size: number }>
  consume(ids: readonly string[]): Promise<InboundAttachment[]>
  dispose(): Promise<void>
}

export interface WebUploadStagerOptions {
  directory: string
  maxBytes: number
  maxFiles?: number
  maxTotalBytes?: number
  ttlMs?: number
  now?: () => number
}

interface StagedUpload {
  attachment: InboundAttachment
  stagedPath: string
  expiresAt: number
}

export function createWebUploadStager(options: WebUploadStagerOptions): WebUploadStager {
  const stagingDirectory = path.join(options.directory, '.staging')
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxTotalBytes = options.maxTotalBytes ?? options.maxBytes * 3
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now
  const staged = new Map<string, StagedUpload>()
  let stagedBytes = 0
  let initializePromise: Promise<void> | null = null
  let cleanupTimer: ReturnType<typeof setInterval> | null = null

  const initialize = (): Promise<void> => {
    if (initializePromise) return initializePromise
    initializePromise = (async () => {
      await mkdir(options.directory, { recursive: true })
      await rm(stagingDirectory, { recursive: true, force: true })
      await mkdir(stagingDirectory, { recursive: true })
      staged.clear()
      stagedBytes = 0
      cleanupTimer = setInterval(() => void cleanupExpired().catch(() => undefined), Math.min(ttlMs, 60_000))
      if (typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) cleanupTimer.unref()
    })()
    return initializePromise
  }

  const cleanupExpired = async (): Promise<void> => {
    const currentTime = now()
    const expired = [...staged.entries()].filter(([, upload]) => upload.expiresAt <= currentTime)
    await Promise.all(expired.map(([, upload]) => rm(upload.stagedPath, { force: true })))
    for (const [id, upload] of expired) {
      staged.delete(id)
      stagedBytes = Math.max(0, stagedBytes - (upload.attachment.fileSize ?? 0))
    }
  }

  return {
    initialize,
    async stage(file) {
      await initialize()
      await cleanupExpired()
      if (!file.size || file.size > options.maxBytes)
        throw new Error(`File size must be between 1 and ${options.maxBytes} bytes`)
      if (staged.size >= maxFiles) throw new Error(`Too many staged uploads; maximum is ${maxFiles}`)
      if (stagedBytes + file.size > maxTotalBytes)
        throw new Error(`The staged upload size limit is ${maxTotalBytes} bytes`)

      const id = crypto.randomUUID()
      const name = path.basename((file.name || 'upload').replaceAll('\\', '/'))
      const mimeType = file.type || 'application/octet-stream'
      const stagedPath = path.join(stagingDirectory, `${id}-${name}`)
      await Bun.write(stagedPath, file)
      const attachment: InboundAttachment = {
        kind: mimeType.startsWith('image/') ? 'photo' : 'document',
        fileId: id,
        fileName: name,
        mimeType,
        fileSize: file.size,
        localPath: stagedPath,
      }
      staged.set(id, { attachment, stagedPath, expiresAt: now() + ttlMs })
      stagedBytes += file.size
      return { id, name, mimeType, size: file.size }
    },
    async consume(ids) {
      await initialize()
      await cleanupExpired()
      if (new Set(ids).size !== ids.length) throw new Error('One or more uploads are unavailable')
      const resolved = ids.map(id => staged.get(id))
      if (resolved.some(upload => !upload)) throw new Error('One or more uploads are unavailable')

      const uploads = resolved as StagedUpload[]
      const moves = uploads.map(upload => ({
        upload,
        finalPath: path.join(options.directory, path.basename(upload.stagedPath)),
      }))
      const completed: typeof moves = []
      try {
        for (const move of moves) {
          await rename(move.upload.stagedPath, move.finalPath)
          completed.push(move)
        }
      } catch (error) {
        await Promise.all(
          completed.reverse().map(move => rename(move.finalPath, move.upload.stagedPath).catch(() => undefined)),
        )
        throw error
      }

      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index]!
        const upload = uploads[index]!
        staged.delete(id)
        stagedBytes = Math.max(0, stagedBytes - (upload.attachment.fileSize ?? 0))
      }
      return moves.map(({ upload, finalPath }) => ({ ...upload.attachment, localPath: finalPath }))
    },
    async dispose() {
      if (cleanupTimer) clearInterval(cleanupTimer)
      cleanupTimer = null
    },
  }
}
