/** Transport 共用的无状态辅助函数。 */

const FORBIDDEN_FILE_NAME_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

export function sanitizeFileName(name: string, fallback: string): string {
  const cleaned = [...name]
    .map(character => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || FORBIDDEN_FILE_NAME_CHARS.has(character) ? '_' : character
    })
    .join('')
    .trim()
  return cleaned || fallback
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
