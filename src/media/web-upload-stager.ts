import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { InboundAttachment } from '../shared'

export interface WebUploadStager {
  stage(file: File): Promise<{ id: string; name: string; mimeType: string; size: number }>
  consume(ids: readonly string[]): Promise<InboundAttachment[]>
}

export function createWebUploadStager(options: { directory: string; maxBytes: number }): WebUploadStager {
  const staged = new Map<string, InboundAttachment>()
  return {
    async stage(file) {
      if (!file.size || file.size > options.maxBytes)
        throw new Error(`File size must be between 1 and ${options.maxBytes} bytes`)
      await mkdir(options.directory, { recursive: true })
      const id = crypto.randomUUID()
      const name = path.basename(file.name || 'upload')
      const mimeType = file.type || 'application/octet-stream'
      const localPath = path.join(options.directory, `${id}-${name}`)
      await Bun.write(localPath, file)
      staged.set(id, {
        kind: mimeType.startsWith('image/') ? 'photo' : 'document',
        fileId: id,
        fileName: name,
        mimeType,
        fileSize: file.size,
        localPath,
      })
      return { id, name, mimeType, size: file.size }
    },
    async consume(ids) {
      const resolved = ids.map(id => staged.get(id))
      if (resolved.some(file => !file)) throw new Error('One or more uploads are unavailable')
      for (const id of ids) staged.delete(id)
      return resolved as InboundAttachment[]
    },
  }
}
