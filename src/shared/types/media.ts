/**
 * 媒体预处理抽象类型。
 *
 * Transport 负责平台鉴权、下载与 metadata 收集；预处理通过 Composition Root 注入，
 * 避免 transport/ 依赖具体 media 实现。非图片文件上传时只登记 metadata/localPath，
 * 具体读取/解析/OCR/转换应等用户明确下指令后再做。
 */

export interface InboundEmoji {
  emoji: string
  name: string
  keywords: string[]
}

export interface InboundCustomEmoji {
  customEmojiId: string
  text: string
}

export interface InboundSticker {
  emoji?: string
  setName?: string
  customEmojiId?: string
  isAnimated: boolean
  isVideo: boolean
  fileId: string
  fileUniqueId?: string
  width?: number
  height?: number
  fileSize?: number
}

export type InboundAttachmentKind =
  'photo' | 'document' | 'audio' | 'voice' | 'video' | 'video_note' | 'animation' | 'other'

export interface InboundAttachment {
  kind: InboundAttachmentKind
  fileId: string
  fileUniqueId?: string
  fileName?: string
  mimeType?: string
  fileSize?: number
  localPath: string
}

export interface MediaPreprocessInput {
  text: string
  emojis?: InboundEmoji[]
  customEmojis?: InboundCustomEmoji[]
  stickers?: InboundSticker[]
  attachments?: InboundAttachment[]
}

export interface MediaPreprocessResult {
  text: string
  warnings: string[]
}

export interface MediaPreprocessor {
  preprocess(input: MediaPreprocessInput): Promise<MediaPreprocessResult>
}

export interface OcrInput {
  localPath: string
  mimeType?: string
  fileName?: string
}

export type OcrBox = [[number, number], [number, number], [number, number], [number, number]]

export interface OcrLine {
  text: string
  score: number
  box: OcrBox
}

export type OcrResult =
  | { status: 'ok'; text: string; lines?: OcrLine[] }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string }

export interface OcrProvider {
  recognize(input: OcrInput): Promise<OcrResult>
}

export interface FileTextInput {
  localPath: string
  mimeType?: string
  fileName?: string
}

export type FileTextResult =
  | { status: 'ok'; text: string; warnings?: string[] }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; reason: string }

export interface FileTextExtractor {
  extract(input: FileTextInput): Promise<FileTextResult>
}

export interface StoredFileReference {
  sequence: number
  kind: InboundAttachmentKind
  fileName: string | null
  mimeType: string | null
  localPath: string
}

export type FileContentResult =
  | { status: 'ok'; text: string; warnings?: string[] }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; reason: string }

export interface FileContentReader {
  read(file: StoredFileReference): Promise<FileContentResult>
}
