import type { InboundEmoji } from '../shared'

const EMOJI_INFO: Record<string, { name: string; keywords: string[] }> = {
  '😀': { name: 'grinning face', keywords: ['happy', 'smile'] },
  '😄': { name: 'grinning face with smiling eyes', keywords: ['happy', 'smile'] },
  '😅': { name: 'grinning face with sweat', keywords: ['relief', 'awkward', 'smile'] },
  '😂': { name: 'face with tears of joy', keywords: ['laugh', 'funny'] },
  '😊': { name: 'smiling face with smiling eyes', keywords: ['happy', 'warm'] },
  '😍': { name: 'smiling face with heart-eyes', keywords: ['love', 'like'] },
  '😭': { name: 'loudly crying face', keywords: ['crying', 'sad', 'overwhelmed'] },
  '😢': { name: 'crying face', keywords: ['sad', 'tear'] },
  '😡': { name: 'pouting face', keywords: ['angry', 'mad'] },
  '🤔': { name: 'thinking face', keywords: ['thinking', 'question'] },
  '🙄': { name: 'face with rolling eyes', keywords: ['annoyed', 'skeptical'] },
  '👍': { name: 'thumbs up', keywords: ['approve', 'ok', 'good'] },
  '🙏': { name: 'folded hands', keywords: ['thanks', 'please', 'pray'] },
  '❤️': { name: 'red heart', keywords: ['love', 'heart'] },
  '🔥': { name: 'fire', keywords: ['hot', 'great', 'urgent'] },
  '🎉': { name: 'party popper', keywords: ['celebrate', 'success'] },
  '✅': { name: 'check mark button', keywords: ['done', 'success', 'yes'] },
  '❌': { name: 'cross mark', keywords: ['no', 'failed', 'cancel'] },
  '⚠️': { name: 'warning', keywords: ['warning', 'attention'] },
  '🚀': { name: 'rocket', keywords: ['launch', 'fast', 'deploy'] },
}

const EMOJI_RE = /\p{Extended_Pictographic}\uFE0F?/gu

function codePointLabel(emoji: string): string {
  return [...emoji].map(ch => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}`).join(' ')
}

export function normalizeEmojis(text: string): InboundEmoji[] {
  const found = new Map<string, InboundEmoji>()
  for (const match of text.matchAll(EMOJI_RE)) {
    const emoji = match[0]
    const info = EMOJI_INFO[emoji] ?? { name: `emoji ${codePointLabel(emoji)}`, keywords: ['emoji'] }
    found.set(emoji, { emoji, name: info.name, keywords: info.keywords })
  }
  return [...found.values()]
}
