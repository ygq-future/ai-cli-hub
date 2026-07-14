import path from 'node:path'
import type {
  InboundAttachment,
  InboundCustomEmoji,
  InboundEmoji,
  InboundSticker,
  MediaPreprocessInput,
  MediaPreprocessResult,
  MediaPreprocessor,
  OcrProvider,
} from '../shared'
import { normalizeEmojis } from './emoji'
import { UNCONFIGURED_OCR_PROVIDER } from './ocr'

export interface MediaPreprocessorOptions {
  maxTextChars: number
  ocrProvider?: OcrProvider
}

function compact(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function isImageAttachment(file: InboundAttachment): boolean {
  const mime = file.mimeType?.toLowerCase()
  const ext = path.extname(file.fileName ?? file.localPath).toLowerCase()
  return Boolean(
    mime?.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(ext),
  )
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`
}

function formatEmoji(emoji: InboundEmoji): string {
  const keywords = emoji.keywords.length > 0 ? `; keywords: ${emoji.keywords.join(', ')}` : ''
  return `- ${emoji.emoji}: ${emoji.name}${keywords}`
}

function formatCustomEmoji(emoji: InboundCustomEmoji): string {
  return `- text="${emoji.text}", custom_emoji_id=${emoji.customEmojiId}`
}

function formatSticker(sticker: InboundSticker): string {
  const parts = [
    compact(sticker.emoji ? `emoji=${sticker.emoji}` : undefined),
    compact(sticker.setName ? `set_name=${sticker.setName}` : undefined),
    compact(sticker.customEmojiId ? `custom_emoji_id=${sticker.customEmojiId}` : undefined),
    `is_animated=${sticker.isAnimated}`,
    `is_video=${sticker.isVideo}`,
    `file_id=${sticker.fileId}`,
    compact(sticker.fileUniqueId ? `file_unique_id=${sticker.fileUniqueId}` : undefined),
    sticker.width && sticker.height ? `size=${sticker.width}x${sticker.height}` : null,
    sticker.fileSize ? `bytes=${sticker.fileSize}` : null,
  ].filter((part): part is string => Boolean(part))
  return `- ${parts.join(', ')}`
}

function formatAttachmentMeta(file: InboundAttachment): string {
  const parts = [
    `kind=${file.kind}`,
    compact(file.fileName ? `name=${file.fileName}` : undefined),
    compact(file.mimeType ? `mime=${file.mimeType}` : undefined),
    file.fileSize ? `bytes=${file.fileSize}` : null,
    compact(file.fileId ? `file_id=${file.fileId}` : undefined),
    `local_path=${file.localPath.replace(/\\+/g, '/')}`,
  ].filter((part): part is string => Boolean(part))
  return `- ${parts.join(', ')}`
}

async function parseAttachment(
  file: InboundAttachment,
  maxTextChars: number,
  ocrProvider: OcrProvider,
): Promise<{ lines: string[]; warnings: string[] }> {
  const lines = [formatAttachmentMeta(file)]
  const warnings: string[] = []

  if (isImageAttachment(file)) {
    const result = await ocrProvider.recognize({
      localPath: file.localPath,
      mimeType: file.mimeType,
      fileName: file.fileName,
    })
    if (result.status === 'ok') {
      lines.push('  ocr_text:')
      lines.push(truncate(result.text, maxTextChars).replace(/^/gm, '    '))
    } else {
      const warning = `OCR ${result.status}: ${result.reason}`
      warnings.push(warning)
      lines.push(`  ocr_status: ${warning}`)
    }
    return { lines, warnings }
  }

  lines.push('  content_status: saved_only_lazy_load')
  lines.push(
    '  instruction: do not read, parse, summarize, convert, move, or otherwise process this file unless the user explicitly asks.',
  )
  return { lines, warnings }
}

export function createMediaPreprocessor(options: MediaPreprocessorOptions): MediaPreprocessor {
  const ocrProvider = options.ocrProvider ?? UNCONFIGURED_OCR_PROVIDER

  return {
    async preprocess(input: MediaPreprocessInput): Promise<MediaPreprocessResult> {
      const sections: string[] = []
      const warnings: string[] = []

      const emojis = [...normalizeEmojis(input.text), ...(input.emojis ?? [])]
      if (emojis.length) {
        sections.push('Emoji context:')
        sections.push(...emojis.map(formatEmoji))
      }

      if (input.customEmojis?.length) {
        sections.push('Telegram custom emoji metadata:')
        sections.push(...input.customEmojis.map(formatCustomEmoji))
      }

      if (input.stickers?.length) {
        sections.push('Telegram sticker metadata:')
        sections.push(...input.stickers.map(formatSticker))
        sections.push('Sticker visual understanding is deferred; only metadata is included.')
      }

      if (input.attachments?.length) {
        sections.push('Current message file/attachment context:')
        sections.push(
          'Non-image files are saved only and must be treated as lazy-load files. Do not inspect/read/parse/summarize/convert/move them unless the user explicitly asks.',
        )
        sections.push('For image attachments only, ocr_text below may be used directly as already extracted content.')
        for (const attachment of input.attachments) {
          const parsed = await parseAttachment(attachment, options.maxTextChars, ocrProvider)
          sections.push(...parsed.lines)
          warnings.push(...parsed.warnings)
        }
      }

      if (sections.length === 0) return { text: input.text, warnings }

      const base = input.text.trim() || '[media message]'
      return {
        text: `${base}\n\n[File preprocessing context]\n${sections.join('\n')}`,
        warnings,
      }
    },
  }
}
