import { useState } from 'react'

export function useCursorPage() {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const currentCursor = cursors.at(-1)

  return {
    currentCursor,
    hasPrevious: cursors.length > 1,
    reset: () => setCursors([undefined]),
    goNext: (cursor: string) => setCursors(current => [...current, cursor]),
    goPrevious: () => {
      const previous = cursors.length > 1 ? cursors[cursors.length - 2] : undefined
      setCursors(current => (current.length > 1 ? current.slice(0, -1) : current))
      return previous
    },
  }
}
