import { describe, expect, test } from 'bun:test'
import { findFirstPlaceholderRange, searchCommandCatalog } from './command-palette-model'

describe('command palette search', () => {
  test('returns stable catalog order for an empty slash query', () => {
    expect(searchCommandCatalog('/', 'zh')[0]?.command).toBe('/start')
    expect(searchCommandCatalog('/', 'zh').some(item => item.id === 'update-confirm')).toBe(true)
  })

  test('gives command prefixes absolute priority', () => {
    expect(searchCommandCatalog('/mo', 'zh').map(item => item.id)).toEqual(['model'])
    expect(searchCommandCatalog('/restart c', 'en')[0]?.id).toBe('restart-confirm')
  })

  test('falls back to bilingual keyword and subsequence matching', () => {
    expect(searchCommandCatalog('/更换模型', 'zh')[0]?.id).toBe('model')
    expect(searchCommandCatalog('/approval history', 'zh')[0]?.id).toBe('audit')
    expect(searchCommandCatalog('/hlth', 'en')[0]?.id).toBe('health')
  })

  test('returns no entries for unrelated text', () => {
    expect(searchCommandCatalog('/完全不相关内容', 'zh')).toEqual([])
  })
})

describe('command template placeholder selection', () => {
  test('selects the first complete optional placeholder', () => {
    expect(findFirstPlaceholderRange('/model [model_name|model_id]')).toEqual({ start: 7, end: 28 })
  })

  test('selects the first complete placeholder when several exist', () => {
    expect(findFirstPlaceholderRange('/switch <cli> [path]')).toEqual({ start: 8, end: 13 })
    expect(findFirstPlaceholderRange('/file [limit] [keyword]')).toEqual({ start: 6, end: 13 })
  })

  test('leaves fixed commands at the end', () => {
    expect(findFirstPlaceholderRange('/update confirm')).toBeNull()
  })
})
