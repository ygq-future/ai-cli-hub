import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { getCommandDescription, type CommandCatalogEntry, type UserLanguage } from '../shared'

interface CommandPaletteProps {
  items: readonly CommandCatalogEntry[]
  language: UserLanguage
  selectedIndex: number
  onSelectedIndexChange: (index: number) => void
  onSelect: (entry: CommandCatalogEntry) => void
}

interface MarqueeStyle extends CSSProperties {
  '--marquee-distance': string
  '--marquee-duration': string
}

function MarqueeDescription({ children }: { children: string }) {
  const viewport = useRef<HTMLSpanElement>(null)
  const track = useRef<HTMLSpanElement>(null)
  const [distance, setDistance] = useState(0)

  useLayoutEffect(() => {
    const measure = () => {
      const nextDistance = Math.max(0, (track.current?.scrollWidth ?? 0) - (viewport.current?.clientWidth ?? 0))
      setDistance(current => (current === nextDistance ? current : nextDistance))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    if (viewport.current) observer.observe(viewport.current)
    if (track.current) observer.observe(track.current)
    return () => observer.disconnect()
  }, [children])

  const style: MarqueeStyle = {
    '--marquee-distance': `${distance}px`,
    '--marquee-duration': `${Math.max(3.2, 2.4 + distance / 28)}s`,
  }
  return (
    <span ref={viewport} className={`command-description ${distance > 0 ? 'overflowing' : ''}`} style={style}>
      <span className="command-description-static">{children}</span>
      <span ref={track} className="command-description-track" aria-hidden="true">
        {children}
      </span>
    </span>
  )
}

export function CommandPalette({
  items,
  language,
  selectedIndex,
  onSelectedIndexChange,
  onSelect,
}: CommandPaletteProps) {
  const selected = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    selected.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, items])

  return (
    <div className="command-palette" id="command-palette" role="listbox" aria-label="Slash commands">
      {items.length ? (
        items.map((item, index) => {
          const active = index === selectedIndex
          return (
            <button
              ref={active ? selected : undefined}
              className={`command-option ${active ? 'selected' : ''}`}
              id={`command-option-${item.id}`}
              key={item.id}
              type="button"
              role="option"
              aria-selected={active}
              onMouseEnter={() => onSelectedIndexChange(index)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => onSelect(item)}>
              <code className="command-name">{item.command}</code>
              <MarqueeDescription>{getCommandDescription(item, language)}</MarqueeDescription>
            </button>
          )
        })
      ) : (
        <div className="command-empty" role="status">
          {language === 'zh' ? '没有匹配的命令' : 'No matching command'}
        </div>
      )}
    </div>
  )
}
